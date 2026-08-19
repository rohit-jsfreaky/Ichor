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
import { classify, isChallenge, type Verdict } from '../scope/classify.js';
import { parsePending } from '../scope/pending.js';
import {
  loadTask,
  toNeighborhood,
  markChallenged,
  markForced,
  markJudged,
  recordOverlay,
  type OverlayFile,
} from '../state.js';
import { parseHookInput, isEditingTool, isShellTool, type HookPayload } from './input.js';
import { agentOf, emitContext, handlePrompt } from './prompt.js';
import { handleStop } from './stop.js';
import { judgeBashChanges } from './bashGate.js';
import { repoIdFor } from '../ids.js';

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

/**
 * Say something about a change that has ALREADY happened.
 *
 * PostToolUse cannot deny — the tool has run and the bytes are on disk — so this
 * is feedback, not a block. The point is timing: the agent has not yet built
 * anything on top of the change, and it has to answer before it does.
 *
 * TWO CHANNELS IN ONE OBJECT, ON PURPOSE. The hook contract for PostToolUse has
 * moved: `decision: "block"` is honoured by some versions, `additionalContext`
 * by others, and unknown fields are ignored by both. Emitting both means the
 * message lands whichever is current, and the failure mode if neither is
 * honoured is silence — never a false block. `ICHOR_POST_CHANNEL=stderr`
 * switches to exit-2 + stderr, the third documented route, without a rebuild.
 */
function postFeedback(reason: string): void {
  if (process.env.ICHOR_POST_CHANNEL === 'stderr') {
    // Exit 2 is the documented "blocking error, show stderr to Claude" path.
    process.stderr.write(reason);
    process.exit(2);
  }

  writeStdoutSync(
    JSON.stringify({
      decision: 'block',
      reason,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: reason,
      },
    }),
  );
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

/**
 * Turn a verdict into the message the agent reads.
 *
 * `file` is taken separately rather than dug out of the verdict text, because the
 * closing line quotes a runnable command and a command with a placeholder in it is
 * a command nobody runs.
 */
export function formatChallenge(verdict: Verdict, task: string, file = '<file>'): string {
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

  /**
   * Name the mechanism, not the loophole.
   *
   * This used to close with *"explain why and proceed — Ichor asks once per file"*,
   * which describes retrying as an accepted answer while offering no working way to
   * explain: the MCP tool that took an argument was unreachable on any untrusted
   * workspace, which is the default for a fresh clone. Measured live — five
   * challenges, five silent retries, no explanation offered to the developer and no
   * Judge call. The message was teaching the shortcut.
   *
   * `ichor justify` needs no permission and reaches the same Judge, so there is now
   * something to point at. Retrying still works and is still recorded as forced —
   * Ichor is not a blocker — but it is no longer the only door, so it stops being
   * the obvious one.
   */
  lines.push('');
  lines.push('If this IS required by the task, say why and have it weighed against the graph:');
  lines.push(`  ichor justify ${file} "<why the task needs it>"`);
  lines.push(
    'A supported reason expands the boundary. If it is not required, prefer the smaller ' +
      'change that stays on the existing path.',
  );

  return lines.join('\n');
}

/**
 * What the file will contain if this tool call goes through.
 *
 * A `Write` carries the whole file already. An `Edit` carries only `new_string`,
 * and parsing that fragment as a module is how an edit that DELETES a widely-used
 * export looked exactly like one that changed a function's insides — the fragment
 * shows what arrives and never what leaves.
 *
 * At PreToolUse the file on disk is still the old version, so applying the
 * substitution here gives the exact proposed file. Returns undefined rather than
 * guessing whenever the old text cannot be found — a stale read, a substitution
 * appearing more than once, a file too large to be worth it.
 */
function proposedContent(
  repoRoot: string,
  intent: { operation: string; file: string; content?: string; replace?: { from: string; to: string } },
): { content?: string; whole: boolean } {
  // A Write carries the file entire; an Edit's `content` is only `new_string`.
  const fragment = { content: intent.content, whole: intent.operation === 'create' };

  if (!intent.replace) return fragment;

  let current: string;
  try {
    const full = path.join(repoRoot, intent.file);
    // A file this large is generated or vendored; reading it on every keystroke
    // costs more than the check is worth.
    if (fs.statSync(full).size > 2_000_000) return fragment;
    current = fs.readFileSync(full, 'utf8');
  } catch {
    return fragment; // not on disk yet — a create in Edit's clothing
  }

  const at = current.indexOf(intent.replace.from);
  if (at === -1) return fragment;
  // Ambiguous. Two identical passages mean we cannot know which one the host
  // will replace, and picking wrong would report a surface change that is not
  // happening.
  if (current.indexOf(intent.replace.from, at + 1) !== -1) return fragment;

  return {
    content: current.slice(0, at) + intent.replace.to + current.slice(at + intent.replace.from.length),
    whole: true,
  };
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

    // Route on the EVENT before anything else. The editing-tool gate below is
    // fatal to a payload that carries no tool at all, so a prompt or a turn-end
    // event would die there without ever reaching its handler.
    const event = String(payload.hook_event_name ?? '');
    if (event === 'UserPromptSubmit') {
      debug('--- UserPromptSubmit');
      const outcome = await handlePrompt(payload, repoRoot);
      for (const line of outcome.log) debug(line);
      emitContext(outcome.context, agentOf(payload));
      process.exit(0);
    }
    if (event === 'Stop' || event === 'SubagentStop') {
      debug(`--- ${event}`);
      for (const line of handleStop(repoRoot)) debug(line);
      allow();
      return;
    }

    /**
     * A shell command has finished. Judge whatever it changed.
     *
     * Placed here, before the editing-tool gate, because the tool that fires this
     * is `Bash` — which that gate exists to reject. See hook/bashGate.ts for why
     * this is post-hoc and why that is the honest design rather than a shortcut.
     */
    if (event === 'PostToolUse') {
      const tool = String(payload.tool_name ?? '');
      if (!isShellTool(tool)) allow();
      debug(`--- PostToolUse ${tool}`);
      const outcome = await judgeBashChanges(repoRoot);
      for (const line of outcome.log) debug(line);
      if (outcome.challenge) {
        const task = loadTask(repoRoot);
        postFeedback(formatChallenge(outcome.challenge, task?.task ?? '', outcome.challengedFile));
      }
      allow();
      return;
    }

    debug(`--- ${String(payload.tool_name ?? '?')}`);

    const task = loadTask(repoRoot);
    if (!task) { debug('no active task -> allow'); allow(); }

    const toolName = String(payload.tool_name ?? '');
    if (!isEditingTool(toolName)) { debug(`not an editing tool (${toolName}) -> allow`); allow(); }

    const { intents, outside } = parseHookInput(payload, repoRoot);

    // Not this repository, so not Ichor's business. Said out loud rather than
    // waved through in silence, because "Ichor was quiet" and "Ichor decided this
    // was none of its concern" are different things to read in a log.
    for (const p of outside) debug(`${p} is outside the repo -> not judged`);

    if (intents.length === 0) { debug('no intents parsed -> allow'); allow(); }

    const neighborhood = toNeighborhood(task!);

    // Files already challenged, or explicitly justified, are not re-asked. Being
    // nagged twice about the same file is how a tool gets switched off.
    const settled = new Set([...task!.challenged, ...task!.justified.map((j) => j.file)]);

    client = new GraphClient(configFromEnv());

    const deadline = Date.now() + TIME_BUDGET_MS;

    // Tier two: what the agent is writing, remembered so a file it creates now
    // is understood when it builds on it two edits later. Name-based and weaker
    // than the graph — never quoted back as evidence (rule 1).
    const overlay: OverlayFile[] = [];
    // Every file that reaches a decision, allowed ones included. Silence leaves
    // no other trace, so without this an edit Ichor never saw is indistinguishable
    // from one it deliberately passed.
    const judged: string[] = [];
    const seenAt = new Date().toISOString();

    for (const intent of intents) {
      if (intent.operation === 'delete') {
        overlay.push({ path: intent.file, calls: [], imports: [], touches: [], routeMethods: [], deleted: true, at: seenAt });
        judged.push(intent.file);
        continue;
      }
      if (settled.has(intent.file)) {
        debug(`${intent.file} already settled -> skip`);
        // Writing a challenged file again, with no justification recorded, is
        // the agent pushing it through. Allowed — Ichor is not a blocker — but
        // remembered, so this code never becomes evidence for the next change.
        markForced(repoRoot, intent.file);
        judged.push(intent.file);
        continue;
      }
      if (Date.now() > deadline) { debug('time budget exhausted -> allow'); break; }

      const proposed = proposedContent(repoRoot, intent);
      const pending = proposed.content ? parsePending(intent.file, proposed.content) : undefined;
      if (pending) {
        overlay.push({
          path: intent.file,
          calls: pending.callsNames,
          imports: pending.importsRepoFiles,
          touches: pending.touches.map((t) => t.model),
          routeMethods: pending.routeMethods,
          at: seenAt,
        });
      }

      let verdict;
      try {
        verdict = await classify(intent, {
          repo: repoIdFor(repoRoot),
          client,
          neighborhood,
          pending,
          wholeFile: proposed.whole,
          forced: task!.forced.map((f) => f.file),
        });
      } catch (error) {
        // One edit failing to classify must not stop the others, and must never
        // block. Surfaced under ICHOR_DEBUG so it is findable.
        debug(`classify failed for ${intent.file}`, error);
        continue;
      }
      debug(`${intent.file} -> ${verdict.decision}`);
      judged.push(intent.file);

      if (isChallenge(verdict)) {
        // Record what we learned before challenging: the edit is about to be
        // refused, so nothing here lands on disk, but the challenge itself is
        // state we must not lose.
        recordOverlay(repoRoot, overlay.filter((o) => o.path !== intent.file));
        markJudged(repoRoot, judged);
        markChallenged(repoRoot, intent.file);
        await client.close();
        deny(formatChallenge(verdict, task!.task, intent.file));
        return;
      }
    }

    recordOverlay(repoRoot, overlay);
    markJudged(repoRoot, judged);
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
