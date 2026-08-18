/**
 * Judging file changes that arrive through a shell command.
 *
 * WHY THIS EXISTS.
 *
 * Ichor's PreToolUse gate watches the editing tools — `Edit`, `Write`,
 * `MultiEdit`, `apply_patch`. That was the whole road until Claude Code began
 * injecting this into auto-mode turns for some models:
 *
 *   "make file changes with sed, heredocs, or short scripts, rather than using
 *    the dedicated Read, Edit, or Write tools."
 *
 * Measured on one repository: three consecutive sessions wrote every edit through
 * `python - <<EOF` and the PreToolUse hook fired for none of them. Ichor's own
 * Stop handler noticed afterwards — "1 file(s) changed that Ichor never judged" —
 * naming a file that was IN scope and would have passed. By then the turn is over.
 *
 * WHY IT IS POST-HOC, AND WHY THAT IS NOT A COMPROMISE.
 *
 * You cannot know what a shell command will write before it runs. `sed -i` is
 * readable; `python build.py` is not, and parsing toward a guess would mean
 * claiming protection that a slightly unusual command silently voids. Ichor does
 * not assert more than its evidence supports (ENGINEERING-RULES rule 3), so it
 * waits for the evidence: the command runs, and then the change on disk is read
 * and judged by exactly the classifier the editing tools go through.
 *
 * The bytes are already written when the question is asked. What is preserved is
 * the thing that actually matters — the agent has not yet built anything on top of
 * them, and must answer before it does.
 *
 * SPEED IS A CORRECTNESS CONCERN HERE. This runs after EVERY shell command, most
 * of which change nothing at all. A `seen` high-water mark and one `git status`
 * keep the empty case to a couple of stats, and the whole module fails open.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { GraphClient, configFromEnv } from '../graph/client.js';
import { repoIdFor } from '../ids.js';
import { gitChangedEntries } from '../refresh/refresh.js';
import { refreshInProgress } from '../refresh/refresh.js';
import { classify, isChallenge, type Verdict } from '../scope/classify.js';
import { parsePending } from '../scope/pending.js';
import {
  loadTask,
  markChallenged,
  markForced,
  markJudged,
  recordOverlay,
  toNeighborhood,
  writeAtomic,
  type OverlayFile,
  type PersistedTask,
} from '../state.js';

/** Same ceiling as the PreToolUse path: never make the agent wait longer than this. */
const TIME_BUDGET_MS = 5_000;

/**
 * How far before the task started a file may have been touched and still count as
 * pre-existing dirt. Matches stop.ts, deliberately: two different answers to "was
 * this changed during the task" would disagree about the same file.
 */
const MTIME_SLACK_MS = 2_000;

/** A file this large is not a hand edit; reading it to classify is not worth the stall. */
const MAX_READ_BYTES = 2_000_000;

interface SeenEntry {
  mtimeMs: number;
  size: number;
}

export interface GateState {
  version: 1;
  /** Which task this state belongs to; a new task discards it. */
  taskStartedAt: string;
  lastCheckAt: number;
  /** Files already gated, by the exact content signature that was gated. */
  seen: Record<string, SeenEntry>;
}

const statePath = (repoRoot: string): string => path.join(repoRoot, '.ichor', 'bash-gate.json');

/**
 * Kept out of `task.json` on purpose.
 *
 * This file is rewritten after every shell command, while `markJudged` and
 * `markChallenged` read-modify-write `task.json`. Sharing one file would put a
 * hot, high-frequency write in contention with the record of what Ichor decided,
 * and losing a challenge to a lost update is not an acceptable trade for one
 * fewer file.
 */
export function loadGateState(repoRoot: string, task: PersistedTask): GateState {
  const fresh: GateState = { version: 1, taskStartedAt: task.startedAt, lastCheckAt: 0, seen: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(repoRoot), 'utf8')) as Partial<GateState>;
    if (parsed.version !== 1 || parsed.taskStartedAt !== task.startedAt) return fresh;
    return {
      version: 1,
      taskStartedAt: task.startedAt,
      lastCheckAt: typeof parsed.lastCheckAt === 'number' ? parsed.lastCheckAt : 0,
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
    };
  } catch {
    // Missing or corrupt is not an error. Reseeding costs one extra judgement.
    return fresh;
  }
}

export function saveGateState(repoRoot: string, state: GateState): void {
  try {
    writeAtomic(statePath(repoRoot), `${JSON.stringify(state)}\n`);
  } catch {
    /* State is an optimisation. Losing it costs a repeat judgement, never a miss. */
  }
}

export interface DiskChange {
  file: string;
  operation: 'create' | 'edit';
  mtimeMs: number;
  size: number;
}

export interface Detection {
  /** Changes that still need a verdict. */
  candidates: DiskChange[];
  /** Files that are gone. Recorded, never challenged — you cannot argue with a delete. */
  deletes: string[];
  /** Files already challenged that were written again: the agent pushing through. */
  forced: string[];
  /** Why nothing was judged, when nothing was. */
  skipped: string[];
}

/**
 * What changed on disk that Ichor has not already accounted for.
 *
 * Pure apart from `fs.statSync` and one `git status`, so it is testable without a
 * graph, a database or a hook payload — which is what makes the short-circuits
 * below verifiable rather than merely asserted.
 */
export function detectBashChanges(
  repoRoot: string,
  task: PersistedTask,
  gate: GateState,
): Detection {
  const since = Date.parse(task.startedAt);
  const candidates: DiskChange[] = [];
  const deletes: string[] = [];
  const forced: string[] = [];
  const skipped: string[] = [];

  // Exactly the set stop.ts calls "accounted": every file Ichor already decided
  // on, by any route. Sharing the definition is the point — two answers to "have
  // I seen this file" would let a file be judged twice or never.
  const accounted = new Set<string>([
    ...task.judged,
    ...task.challenged,
    ...task.justified.map((j) => j.file),
    ...task.forced.map((f) => f.file),
    ...task.overlay.map((o) => o.path),
  ]);

  // Challenged or justified means Ichor has already had this conversation. A
  // further write is the agent pushing through, which is allowed and recorded.
  const settled = new Set([...task.challenged, ...task.justified.map((j) => j.file)]);

  for (const entry of gitChangedEntries(repoRoot)) {
    const rel = entry.path;

    if (settled.has(rel)) {
      forced.push(rel);
      continue;
    }
    if (accounted.has(rel)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(repoRoot, rel));
    } catch {
      // Reported by git and not on disk: deleted. Named, never challenged —
      // parity with the PreToolUse delete branch, which also only records.
      deletes.push(rel);
      continue;
    }

    // A repo that was already dirty when the task opened is not this agent's
    // doing, and challenging someone for their own uncommitted work is the
    // fastest way to get a tool uninstalled.
    if (Number.isFinite(since) && stat.mtimeMs <= since - MTIME_SLACK_MS) {
      gate.seen[rel] = { mtimeMs: stat.mtimeMs, size: stat.size };
      skipped.push(`${rel} predates the task`);
      continue;
    }

    /**
     * The high-water mark, and the reason this is cheap enough to run every time.
     *
     * Once a file has been judged at a given content signature, every later shell
     * command in the same task would otherwise re-read and re-classify it, because
     * git keeps reporting it as dirty until it is committed. Comparing mtime AND
     * size means a genuine rewrite is still caught — the file is only skipped
     * while it is byte-for-byte the thing already gated.
     */
    const seen = gate.seen[rel];
    if (seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) continue;

    candidates.push({
      file: rel,
      operation: entry.status.includes('?') ? 'create' : 'edit',
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }

  return { candidates, deletes, forced, skipped };
}

export interface GateOutcome {
  log: string[];
  /** Present only when something out of scope was found. */
  challenge?: Verdict;
}

/**
 * Detect, then judge.
 *
 * Mirrors the PreToolUse loop deliberately, including its ordering: settled files
 * are forced rather than re-asked, deletes are recorded, the overlay is written
 * before a challenge so what was learned survives, and the time budget is the
 * same. The one difference is where the content comes from — disk, because the
 * write already happened, which makes `wholeFile: true` simply true.
 */
export async function judgeBashChanges(repoRoot: string): Promise<GateOutcome> {
  const log: string[] = [];
  const task = loadTask(repoRoot);
  if (!task) return { log: [] };

  const started = Date.now();
  const gate = loadGateState(repoRoot, task);
  const found = detectBashChanges(repoRoot, task, gate);

  for (const file of found.forced) {
    markForced(repoRoot, file);
    log.push(`post: ${file} was already settled -> forced through`);
  }

  const seenAt = new Date().toISOString();
  if (found.deletes.length > 0) {
    recordOverlay(
      repoRoot,
      found.deletes.map((p) => ({
        path: p,
        calls: [],
        imports: [],
        touches: [],
        routeMethods: [],
        deleted: true,
        at: seenAt,
      })),
    );
    markJudged(repoRoot, found.deletes);
    log.push(`post: recorded ${found.deletes.length} deletion(s)`);
  }

  // THE COMMON CASE. A shell command that changed no source file costs one git
  // call and a small write, with no graph connection opened at all.
  if (found.candidates.length === 0) {
    gate.lastCheckAt = Date.now();
    saveGateState(repoRoot, gate);
    log.push(`post: nothing new to judge (${Date.now() - started}ms)`);
    return { log };
  }

  /**
   * A rebuild is holding the database.
   *
   * Judging against a half-written graph produces a verdict Ichor cannot stand
   * behind, and waiting blocks the agent. So this defers WITHOUT recording the
   * files as seen — they are detected again after the next command, by which time
   * the rebuild has usually finished.
   */
  if (refreshInProgress(repoRoot)) {
    log.push(`post: a rebuild is running -> deferring ${found.candidates.length} change(s)`);
    return { log };
  }

  const client = new GraphClient(configFromEnv());
  const neighborhood = toNeighborhood(task);
  const deadline = started + TIME_BUDGET_MS;
  const overlay: OverlayFile[] = [];
  const judged: string[] = [];

  try {
    for (const change of found.candidates) {
      if (Date.now() > deadline) {
        log.push('post: time budget exhausted -> allowing the rest');
        break;
      }
      if (change.size > MAX_READ_BYTES) {
        log.push(`post: ${change.file} is too large to judge (${change.size} bytes)`);
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(path.join(repoRoot, change.file), 'utf8');
      } catch {
        continue; // Vanished between the stat and the read.
      }

      const pending = parsePending(change.file, content);
      if (pending) {
        overlay.push({
          path: change.file,
          calls: pending.callsNames,
          imports: pending.importsRepoFiles,
          touches: pending.touches.map((t) => t.model),
          routeMethods: pending.routeMethods,
          at: seenAt,
        });
      }

      let verdict: Verdict;
      try {
        verdict = await classify(
          { operation: change.operation, file: change.file, content },
          {
            repo: repoIdFor(repoRoot),
            client,
            neighborhood,
            pending,
            // The file on disk IS the whole file. No reconstruction, no guessing.
            wholeFile: true,
            forced: task.forced.map((f) => f.file),
          },
        );
      } catch (error) {
        log.push(`post: could not classify ${change.file} (${(error as Error).message.slice(0, 60)})`);
        continue;
      }

      log.push(`post: ${change.file} -> ${verdict.decision}`);
      judged.push(change.file);
      gate.seen[change.file] = { mtimeMs: change.mtimeMs, size: change.size };

      if (isChallenge(verdict)) {
        recordOverlay(repoRoot, overlay.filter((o) => o.path !== change.file));
        markJudged(repoRoot, judged);
        markChallenged(repoRoot, change.file);
        gate.lastCheckAt = Date.now();
        saveGateState(repoRoot, gate);
        log.push(`post: challenged ${change.file} (${Date.now() - started}ms)`);
        return { log, challenge: verdict };
      }
    }

    recordOverlay(repoRoot, overlay);
    markJudged(repoRoot, judged);
    gate.lastCheckAt = Date.now();
    saveGateState(repoRoot, gate);
    log.push(`post: judged ${judged.length} change(s), nothing out of scope (${Date.now() - started}ms)`);
    return { log };
  } finally {
    await client.close().catch(() => undefined);
  }
}
