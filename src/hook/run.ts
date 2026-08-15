/**
 * The PreToolUse hook.
 *
 * Reads a hook payload on stdin, classifies the edit, and writes a decision on
 * stdout in the shape BOTH Claude Code and Codex accept:
 *
 *   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *                             "permissionDecision": "deny",
 *                             "permissionDecisionReason": "…" } }
 *
 * 🔒 IT FAILS OPEN. Every unexpected condition — no task, no database, a parse
 * error, a timeout, a crash — allows the edit. A tool that blocks work when it
 * breaks gets uninstalled within the hour, and a false block is far more costly
 * than a missed challenge. Silence is also the correct default when we simply
 * do not know.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GraphClient, configFromEnv } from '../graph/client.js';
import { classify, type Verdict } from '../scope/classify.js';
import { parsePending } from '../scope/pending.js';
import { loadTask, toNeighborhood, markChallenged } from '../state.js';
import { parseHookInput, isEditingTool, type HookPayload } from './input.js';

/** Beyond this, allow the edit rather than make the agent wait. */
const TIME_BUDGET_MS = 5_000;

/**
 * Failing open silently is right in production and impossible to debug.
 *
 * Every invocation appends one line to `.ichor/hook.log`, so "why did Ichor say
 * nothing?" is always answerable after the fact. A file rather than stderr on
 * purpose: writing to stderr perturbs process timing enough to change the
 * outcome, which made an intermittent bug look like a heisenbug.
 *
 * ICHOR_DEBUG=1 additionally mirrors it to stderr for live work.
 */
const DEBUG = process.env.ICHOR_DEBUG === '1';

let logFile: string | undefined;

function debug(message: string, error?: unknown): void {
  const line = `${new Date().toISOString()} ${message}${error ? `: ${(error as Error).stack ?? error}` : ''}\n`;
  if (DEBUG) process.stderr.write(`[ichor] ${line}`);
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    /* logging must never affect the decision */
  }
}

interface HookDecision {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/** Allow: exit 0 with no output means "no decision, carry on". */
function allow(): void {
  process.exit(0);
}

function deny(reason: string): void {
  const decision: HookDecision = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };

  // stdout is a PIPE here, so process.stdout.write() is ASYNCHRONOUS and
  // process.exit() can cut the JSON off mid-message. The agent then parses
  // nothing, no decision is applied, and the challenge is silently dropped.
  //
  // This showed up as a test that passed only when ICHOR_DEBUG was on — the
  // stderr writes delayed exit just enough for stdout to drain. In a real
  // session it would be an intermittently-ignored block, which is worse than
  // no block at all because you would trust it.
  //
  // fs.writeSync on fd 1 blocks until the bytes are gone, which is the only
  // way to be certain before exiting.
  writeStdoutSync(JSON.stringify(decision));
  process.exit(0);
}

/** Write to fd 1 synchronously, tolerating partial writes and EAGAIN. */
function writeStdoutSync(data: string): void {
  const buffer = Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(1, buffer, offset, buffer.length - offset);
    } catch (error) {
      // A non-blocking pipe that is momentarily full. Retry rather than lose
      // the decision.
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      throw error;
    }
  }
}

/** Turn a verdict into the message the agent reads. */
export function formatChallenge(verdict: Verdict, task: string): string {
  const lines: string[] = [];
  lines.push(`⚠ Ichor: this looks like scope expansion.`);
  lines.push('');
  lines.push(`Task: ${task}`);
  lines.push('');
  lines.push(verdict.reason);

  if (verdict.evidence.length) {
    lines.push('');
    lines.push('Evidence from the codebase:');
    for (const e of verdict.evidence.slice(0, 4)) lines.push(`  · ${e.text}`);
  }

  if (verdict.question) {
    lines.push('');
    lines.push(verdict.question);
  }

  lines.push('');
  lines.push(
    'If this is genuinely required, explain why and proceed — Ichor asks once per file. ' +
      'If it is not, prefer the smaller change that stays on the existing path.',
  );

  return lines.join('\n');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runHook(): Promise<void> {
  // Any failure at all -> allow. Wrapped as a whole for exactly that reason.
  let client: GraphClient | undefined;

  try {
    const raw = await readStdin();
    if (!raw.trim()) allow();

    let payload: HookPayload;
    try {
      payload = JSON.parse(raw) as HookPayload;
    } catch {
      allow();
      return;
    }

    const repoRoot = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    logFile = path.join(repoRoot, '.ichor', 'hook.log');
    debug(`--- ${String(payload.tool_name ?? '?')}`);

    const task = loadTask(repoRoot);
    if (!task) { debug('no active task -> allow'); allow(); }

    const toolName = String(payload.tool_name ?? '');
    if (!isEditingTool(toolName)) { debug(`not an editing tool (${toolName}) -> allow`); allow(); }

    const { intents } = parseHookInput(payload, repoRoot);
    if (intents.length === 0) { debug('no intents parsed -> allow'); allow(); }

    const neighborhood = toNeighborhood(task!);

    // Files already challenged, or explicitly justified, are not re-asked. Being
    // nagged twice about the same file is how a tool gets switched off.
    const settled = new Set([...task!.challenged, ...task!.justified.map((j) => j.file)]);

    client = new GraphClient(configFromEnv());

    const deadline = Date.now() + TIME_BUDGET_MS;

    for (const intent of intents) {
      if (intent.operation === 'delete') continue;
      if (settled.has(intent.file)) { debug(`${intent.file} already settled -> skip`); continue; }
      if (Date.now() > deadline) { debug('time budget exhausted -> allow'); break; }

      const pending = intent.content ? parsePending(intent.file, intent.content) : undefined;

      let verdict;
      try {
        verdict = await classify(intent, { client, neighborhood, pending });
      } catch (error) {
        // One edit failing to classify must not stop the others, and must never
        // block. Surfaced under ICHOR_DEBUG so it is findable.
        debug(`classify failed for ${intent.file}`, error);
        continue;
      }
      debug(`${intent.file} -> ${verdict.decision}`);

      if (verdict.decision === 'SUSPICIOUS' || verdict.decision === 'HUMAN_REVIEW') {
        markChallenged(repoRoot, intent.file);
        await client.close();
        deny(formatChallenge(verdict, task!.task));
        return;
      }
    }

    await client.close();
    debug('no challenge raised -> allow');
    allow();
  } catch (error) {
    debug("hook aborted", error);
    // Deliberately silent. A hook writing errors into the agent's transcript is
    // noise at best and confusing at worst.
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    allow();
  }
}
