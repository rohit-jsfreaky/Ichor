/**
 * The turn boundary: what happens when the developer types.
 *
 * This is the answer to the failure that makes Ichor useless in real life.
 * Nobody runs a CLI command between tasks — they work all day in one
 * conversation. A boundary drawn at 9am is still policing vendor code at 2pm
 * while the developer is deep in billing, challenging every edit. So the moment
 * a prompt arrives we ask whether it still points at the area we are watching,
 * and move the boundary when it does not.
 *
 * Two hard rules:
 *
 *   1. NEVER block a prompt. This hook writes plain text on stdout and nothing
 *      else — both hosts treat that as extra context. There is deliberately no
 *      code path here that can emit a decision, so a bug cannot cost someone
 *      their message.
 *   2. When unsure, change nothing. Every ambiguous classification resolves to
 *      NO_SIGNAL, which leaves the boundary exactly where it was.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadFacts, loadIndex } from '../refresh/refresh.js';
import { findAnchors } from '../scope/anchors.js';
import { buildNeighborhood } from '../scope/neighborhood.js';
import { classifyPrompt, type BoundaryView } from '../scope/taskSwitch.js';
import { GraphClient, configFromEnv } from '../graph/client.js';
import {
  loadTask,
  replaceBoundary,
  saveTask,
  stateDir,
  updateTask,
  type PersistedTask,
} from '../state.js';
import { writeStdoutSync } from './stdout.js';
import type { HookPayload } from './input.js';

/** Inline, on a keystroke. Past this we stay quiet rather than make anyone wait. */
const TIME_BUDGET_MS = 1_500;

const WATCH_FILE = 'watch.json';

export const watchPath = (repoRoot: string) => path.join(stateDir(repoRoot), WATCH_FILE);

export function isWatching(repoRoot: string): boolean {
  return fs.existsSync(watchPath(repoRoot));
}

/** Claude Code calls it `user_prompt`; Codex calls it `prompt`. */
export function readPrompt(payload: HookPayload): string {
  for (const key of ['user_prompt', 'prompt'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** Claude Code sends `prompt_id`; Codex sends `turn_id`. Either identifies a turn. */
function readPromptId(payload: HookPayload): string | undefined {
  for (const key of ['prompt_id', 'turn_id'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function boundaryOf(task: PersistedTask): BoundaryView {
  return {
    names: [
      ...task.members.map((m) => m.name),
      ...task.coreModels,
      ...task.anchors.map((a) => a.name),
    ],
    files: [...new Set(task.members.map((m) => m.file))],
  };
}

/**
 * A short description of the boundary, injected into the agent's context.
 *
 * Cheaper for everyone than challenging after the fact: an agent that knows
 * where the task lives mostly stays there. Kept deliberately terse — this is
 * paid for in tokens on every single turn.
 */
export function scopeBriefing(task: PersistedTask): string {
  if (!task.members.length) return '';

  const names = task.members
    .slice()
    .sort((a, b) => a.distance - b.distance)
    .map((m) => m.name);
  const shown = names.slice(0, 12).join(', ');
  const rest = names.length > 12 ? `, and ${names.length - 12} more` : '';

  const lines = [
    `[ichor] Task boundary: "${task.task}"`,
    `In scope (${names.length}): ${shown}${rest}`,
  ];
  if (task.coreModels.length) lines.push(`Data this task is about: ${task.coreModels.join(', ')}`);
  lines.push(
    'Work outside this will be questioned. If you believe it is required, call ichor_check_change first and explain why.',
  );
  return lines.join('\n');
}

export interface PromptOutcome {
  /** For hook.log — every decision has to be explainable. */
  log: string[];
  context: string;
}

/**
 * Decide what this prompt means for the boundary.
 *
 * Returns the text to inject, if any. Never throws — the caller treats a thrown
 * error as "say nothing", but there should be no way to get there.
 */
export async function handlePrompt(
  payload: HookPayload,
  repoRoot: string,
): Promise<PromptOutcome> {
  const log: string[] = [];
  const prompt = readPrompt(payload);
  if (!prompt) return { log: ['prompt: empty -> nothing to do'], context: '' };

  const promptId = readPromptId(payload);
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;

  const existing = loadTask(repoRoot);

  // A hook can fire twice for one turn. Redrawing twice is harmless but noisy in
  // the log, and doubles the work on the one path that has a time budget.
  if (existing && promptId && existing.lastPromptId === promptId) {
    return { log: [`prompt: ${promptId} already handled -> skip`], context: scopeBriefing(existing) };
  }

  const facts = loadFacts(repoRoot);
  const index = loadIndex(repoRoot);

  if (!existing) {
    if (!isWatching(repoRoot)) return { log: ['prompt: no task and not watching -> ignore'], context: '' };
    if (!facts) return { log: ['prompt: watching but no analysis yet -> stay silent'], context: '' };

    const created = await drawBoundary(repoRoot, prompt, facts, 'watch', sessionId, log);
    if (!created) return { log, context: '' };
    updateTask(repoRoot, (t) => ({ ...t, lastPromptId: promptId }));
    return { log, context: scopeBriefing(created) };
  }

  if (!index || !facts) {
    return { log: ['prompt: no name index -> cannot classify, staying put'], context: scopeBriefing(existing) };
  }

  // A second agent session working in the same repo takes ownership. Recorded
  // rather than resolved: real isolation needs per-session state, which is a
  // bigger change than this one.
  if (sessionId && existing.sessionId && existing.sessionId !== sessionId) {
    log.push(`prompt: session changed (${existing.sessionId} -> ${sessionId})`);
  }

  const verdict = classifyPrompt(prompt, index, boundaryOf(existing));
  log.push(`prompt: ${verdict.verdict} — ${verdict.reason}`);

  if (verdict.verdict === 'NO_SIGNAL' || verdict.verdict === 'SAME') {
    updateTask(repoRoot, (t) => ({ ...t, lastPromptId: promptId, sessionId: sessionId ?? t.sessionId }));
    return { log, context: scopeBriefing(existing) };
  }

  // A task the developer named by hand is theirs to move. Detection still runs
  // and still reports, but it does not redraw a boundary somebody chose.
  if (existing.mode === 'explicit') {
    log.push('prompt: task was set explicitly -> reporting only, not redrawing');
    updateTask(repoRoot, (t) => ({ ...t, lastPromptId: promptId }));
    const note =
      verdict.verdict === 'NEW'
        ? `\n[ichor] This looks like a different task (${verdict.outsideHits.join(', ')}). The boundary below is still the one set with \`ichor start\`. Run \`ichor watch\` to let Ichor follow the conversation instead.`
        : '';
    return { log, context: `${scopeBriefing(existing)}${note}` };
  }

  // WIDENED keeps the job and its history; NEW is a different job entirely.
  const isNew = verdict.verdict === 'NEW';
  const text = isNew ? prompt : `${existing.task} ${prompt}`;
  const drawn = await drawBoundary(
    repoRoot,
    text,
    facts,
    existing.mode,
    sessionId,
    log,
    { replace: true, resetHistory: isNew },
  );

  updateTask(repoRoot, (t) => ({ ...t, lastPromptId: promptId }));
  return { log, context: scopeBriefing(drawn ?? existing) };
}

/**
 * Anchor a task sentence and walk the graph outward.
 *
 * Budgeted: if the graph is slow we abandon the redraw and keep the old
 * boundary, because a developer waiting on their own prompt is a worse failure
 * than a boundary that is one turn out of date.
 */
async function drawBoundary(
  repoRoot: string,
  text: string,
  facts: Parameters<typeof findAnchors>[0],
  mode: PersistedTask['mode'],
  sessionId: string | undefined,
  log: string[],
  options: { replace?: boolean; resetHistory?: boolean } = {},
): Promise<PersistedTask | undefined> {
  const { anchors, terms } = findAnchors(facts, text);
  if (anchors.length === 0) {
    // Nothing in the repo matches — a greenfield feature, most likely. An empty
    // boundary would challenge every edit, so we refuse to draw one.
    log.push('prompt: nothing in the repo matches -> staying silent rather than guessing');
    return undefined;
  }

  const client = new GraphClient(configFromEnv());
  const deadline = Date.now() + TIME_BUDGET_MS;
  try {
    const neighborhood = await buildNeighborhood(client, text, anchors, terms);
    if (Date.now() > deadline) log.push('prompt: boundary took longer than the budget');

    const task = options.replace
      ? replaceBoundary(repoRoot, neighborhood, { resetHistory: options.resetHistory ?? false })
      : saveTask(repoRoot, neighborhood, { mode, sessionId });

    log.push(`prompt: boundary set — ${neighborhood.members.size} functions`);
    if (neighborhood.stats.truncated) {
      // Rule 2: a boundary that stopped early is not the same as one that
      // finished, and everything it did not reach will be challenged.
      log.push(`prompt: ⚠ the task area hit the member cap — edits just outside it may be questioned`);
    }
    return task;
  } catch (error) {
    log.push(`prompt: could not reach the graph (${(error as Error).message.slice(0, 80)})`);
    return undefined;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Emit the briefing. Plain text only — this hook can never block a prompt. */
export function emitContext(context: string): void {
  if (context.trim()) writeStdoutSync(`${context}\n`);
}
