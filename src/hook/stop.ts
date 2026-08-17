/**
 * The agent has finished talking.
 *
 * This is the only moment in a session when the expensive work is free: the
 * human is reading the answer, nothing is half-written, and no edit is in
 * flight. So it is where the graph gets rebuilt.
 *
 * The handler itself does almost nothing — it decides whether a rebuild is
 * warranted and hands off to a detached process. The agent is waiting on this
 * hook to exit, so it must never do the ~3 seconds of analysis inline.
 *
 * It is also the one place that can answer "did anything change that I never
 * saw?", which is why `unseenEdits` runs here and nowhere else.
 */

import fs from 'node:fs';
import path from 'node:path';

import { gitChangedPaths, needsRefresh, spawnRefresh } from '../refresh/refresh.js';
import { loadTask, markUnseenReported, type PersistedTask } from '../state.js';

/** Named in the log rather than counted, up to this many. */
const FILES_NAMED = 4;

/**
 * How much slack to allow when asking "was this changed after the task opened?"
 *
 * Two clocks are being compared and neither is as precise as it looks.
 * `startedAt` is an ISO string, so it is TRUNCATED to whole milliseconds, while
 * `mtimeMs` carries a fraction. A file written in the same millisecond as the
 * prompt therefore lands on either side of the comparison at random — measured
 * here as three reports out of five identical runs. Filesystems make it worse:
 * mtime granularity is a full second on some, two on others, and a coarse value
 * rounds DOWN, placing a genuinely-new file before a task that opened after it.
 *
 * So the comparison gets a deliberate bias, and the direction is the point. A
 * file wrongly named here is one noisy log line. A file wrongly SKIPPED is a
 * missed edit reported as nothing to see, which is the exact failure this whole
 * function exists to prevent — it would make the feature quietly untrue rather
 * than merely chatty.
 *
 * Two seconds is far below the age of a repo that was already dirty when the task
 * opened, which is the only thing being filtered out.
 */
const MTIME_SLACK_MS = 2_000;

/**
 * Files that changed during this task which Ichor never formed a verdict on.
 *
 * Ichor sees an edit only when the agent goes through an edit tool. A shell
 * redirect, a codegen script, a formatter, or the developer's own editor all
 * write files it never hears about — and in one live session a file was modified
 * with no hook event at all, for reasons never established.
 *
 * That gap cannot be closed from inside a PreToolUse hook: you cannot be called
 * for something that never calls you. What it can do is stop being silent about
 * it. An unjudged edit is not an error and is not treated as one; it is stated,
 * so "Ichor said nothing" can be read as "nothing was out of scope" rather than
 * "Ichor was not asked".
 *
 * Exported for the session harness, which asserts a file written behind the
 * hook's back is reported rather than passed over.
 */
export interface UnseenEdit {
  file: string;
  /** 0 when the file is gone, which is itself a change worth naming. */
  mtimeMs: number;
}

export function unseenEditDetails(repoRoot: string, task: PersistedTask): UnseenEdit[] {
  const since = Date.parse(task.startedAt);
  if (!Number.isFinite(since)) return [];

  // Judged, challenged, justified and forced are all files Ichor did decide on.
  // Overlay is included because a file it parsed is a file it saw.
  const accounted = new Set<string>([
    ...task.judged,
    ...task.challenged,
    ...task.justified.map((j) => j.file),
    ...task.forced.map((f) => f.file),
    ...task.overlay.map((o) => o.path),
  ]);

  const reported = new Map(task.reportedUnseen.map((r) => [r.file, r.mtimeMs]));

  const found: UnseenEdit[] = [];
  for (const rel of gitChangedPaths(repoRoot)) {
    if (accounted.has(rel)) continue;

    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(repoRoot, rel)).mtimeMs;
      // Only changes made during the task. A repo that was already dirty when the
      // task opened is not evidence of a missed hook, and reporting it as such
      // would make this line worthless within one session.
      if (mtimeMs <= since - MTIME_SLACK_MS) continue;
    } catch {
      // Deleted between git reporting it and this stat. A deletion Ichor never
      // saw is exactly the case worth naming, so it falls through with mtime 0.
    }

    /**
     * Already named, and unchanged since. Stay quiet.
     *
     * Without this the line repeats at the end of EVERY turn for the rest of the
     * task, because a file written outside an edit tool can never acquire a
     * verdict — no hook will ever fire for it. Observed in a real session: the
     * same file named again a turn later, in a turn that made no edits at all,
     * on the same line as "graph matches the code -> no rebuild".
     *
     * Compared by mtime rather than by path alone, so this suppresses a REPEAT
     * and not a genuinely new change. Write to the same file again by hand and it
     * is named again, because that is new information.
     */
    if (reported.get(rel) === mtimeMs) continue;

    found.push({ file: rel, mtimeMs });
  }

  return found;
}

/**
 * The same question, as paths only.
 *
 * Exported for the session harness and the tests, which assert a file written
 * behind the hook's back is reported rather than passed over.
 */
export function unseenEdits(repoRoot: string, task: PersistedTask): string[] {
  return unseenEditDetails(repoRoot, task).map((u) => u.file);
}

function describeUnseen(files: string[]): string {
  const shown = files.slice(0, FILES_NAMED).join(', ');
  const rest = files.length > FILES_NAMED ? `, +${files.length - FILES_NAMED} more` : '';
  return (
    `stop: ${files.length} file(s) changed that Ichor never judged — ${shown}${rest}` +
    ' (written outside an edit tool, so no hook fired; the rebuild below picks them up)'
  );
}

export function handleStop(repoRoot: string): string[] {
  const log: string[] = [];

  const task = loadTask(repoRoot);
  if (!task) return ['stop: no active task -> nothing to refresh'];

  // Before anything else, because a rebuild is about to fold these edits into
  // the graph and make them indistinguishable from ones that were judged.
  try {
    const unseen = unseenEditDetails(repoRoot, task);
    if (unseen.length > 0) {
      log.push(describeUnseen(unseen.map((u) => u.file)));
      // Recorded so the next turn is quiet. These files will never be judged —
      // nothing will ever call the hook for them — so "report until judged" means
      // "report forever".
      markUnseenReported(repoRoot, unseen);
    }
  } catch {
    // Reporting is a courtesy; failing at it must not cost the rebuild.
  }

  const staleness = needsRefresh(repoRoot);
  if (!staleness.stale) {
    log.push(`stop: ${staleness.why} -> no rebuild`);
    return log;
  }

  const result = spawnRefresh(repoRoot);
  log.push(
    result.spawned
      ? `stop: ${staleness.why} -> rebuild started (${result.why})`
      : `stop: wanted a rebuild (${staleness.why}) but could not start one — ${result.why}`,
  );
  return log;
}
