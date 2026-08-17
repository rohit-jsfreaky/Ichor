/**
 * On-disk state for the active task.
 *
 * The hook runs before every edit, so it cannot rebuild the neighbourhood each
 * time — the boundary is computed once and persisted here, and the hook just
 * reads it. Everything needed to classify without touching ts-morph again.
 *
 * Lives in `.ichor/` in the repo, which `ichor init` adds to .gitignore.
 *
 * TWO TIERS LIVE IN THIS FILE, and the distinction is load-bearing:
 *
 *   members/anchors/models   derived from the COMPILED graph. Authoritative.
 *                            May be quoted as evidence in a challenge.
 *   overlay                  derived from the hook's own cheap parse of a file
 *                            the agent is about to write. Name-based, not
 *                            compiler-resolved. It answers "is this connected
 *                            to something the agent just made?" and must NEVER
 *                            appear in a challenge sentence — that would mean
 *                            challenging an agent on evidence the compiler
 *                            never confirmed (ENGINEERING-RULES rule 1).
 *
 * Every write is atomic. A hook, a background refresh and the CLI can all touch
 * this file, and a half-written task.json reads as a corrupt one, which silently
 * disables policing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Anchor } from './scope/anchors.js';
import type { Neighborhood, NeighborhoodMember } from './scope/neighborhood.js';

export const STATE_DIR = '.ichor';
export const TASK_FILE = 'task.json';

/** How the boundary was set: by the developer, or inferred from their prompt. */
export type TaskMode = 'watch' | 'explicit';

/**
 * One file the agent wrote during this session, as the hook saw it.
 *
 * Tier two. Cheap, name-based, and explicitly weaker than the graph.
 */
export interface OverlayFile {
  path: string;
  /** Identifiers called, by name. */
  calls: string[];
  /** Repo-relative paths imported. */
  imports: string[];
  /** Prisma models touched, by name. */
  touches: string[];
  routeMethods: string[];
  deleted?: boolean;
  at: string;
}

/** A file that was challenged and then written anyway. */
export interface ForcedFile {
  file: string;
  at: string;
}

export interface PersistedTask {
  version: 2;
  task: string;
  startedAt: string;
  repoRoot: string;
  terms: string[];
  anchors: Anchor[];
  members: NeighborhoodMember[];
  models: string[];
  coreModels: string[];
  /** Files the agent was challenged on, so we do not ask twice. */
  challenged: string[];
  /**
   * Every file Ichor formed a verdict on this task — including the ones it
   * allowed, which are otherwise invisible because silence leaves no trace.
   *
   * This exists to answer one question at the end of a turn: did anything change
   * that Ichor never saw? One live session modified a file with no hook event at
   * all, and the only reason it was noticed was a human running `git status`.
   * Without a record of what WAS judged there is nothing to compare against, so
   * a missed edit and a deliberately-allowed edit look identical in the log.
   */
  judged: string[];
  /**
   * Files already named at the end of a turn as "changed but never judged".
   *
   * Reporting is the whole value of that line, and reporting TWICE destroys it. A
   * file written outside an edit tool can never acquire a verdict — no hook will
   * ever fire for it — so without this the same line repeats at the end of every
   * turn for the rest of the task, including turns that changed nothing at all.
   * That is finding 16 again: a warning that fires unconditionally is noise in the
   * one place that has to carry signal.
   *
   * The mtime is stored with the path so this suppresses a repeat, not a genuinely
   * new change. Write to the same file again by hand and it is named again,
   * because that is new information.
   */
  reportedUnseen: { file: string; mtimeMs: number }[];
  /** Files the developer or Judge approved — the boundary after it grew. */
  justified: { file: string; reason: string; at: string }[];
  /**
   * Challenged, never justified, and written anyway.
   *
   * The agent can clear a challenge by simply retrying the same write. That is
   * deliberate — Ichor is not a blocker — but the code it produced must not
   * quietly become tomorrow's precedent, so it is remembered and never cited as
   * an existing path.
   */
  forced: ForcedFile[];
  mode: TaskMode;
  /** Which agent session owns this task, when the host tells us. */
  sessionId?: string;
  /** Last prompt acted on, so a re-fired hook does not redraw twice. */
  lastPromptId?: string;
  overlay: OverlayFile[];
  /** When the compiled graph behind `members` was last built. */
  graphBuiltAt?: string;
  /** Bumped only after a rebuild completes, never before. */
  graphRevision: number;
}

export function stateDir(repoRoot: string): string {
  return path.join(repoRoot, STATE_DIR);
}

export function taskPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), TASK_FILE);
}

/**
 * Write a file so no reader can ever observe it half-written.
 *
 * Same-directory temp plus rename: rename is atomic within a filesystem, and a
 * temp file elsewhere could land on another volume and silently degrade to a
 * copy.
 */
export function writeAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, contents, 'utf8');
  fs.renameSync(temp, file);
}

function writeTask(repoRoot: string, task: PersistedTask): void {
  writeAtomic(taskPath(repoRoot), `${JSON.stringify(task, null, 2)}\n`);
}

/** A boundary and nothing else — the shape `saveTask` and `replaceBoundary` share. */
function boundaryFields(repoRoot: string, neighborhood: Neighborhood) {
  return {
    task: neighborhood.task,
    repoRoot,
    terms: neighborhood.terms,
    anchors: neighborhood.anchors,
    members: [...neighborhood.members.values()],
    models: [...neighborhood.models.values()].map((m) => m.name),
    coreModels: [...neighborhood.coreModels],
  };
}

export interface SaveOptions {
  mode?: TaskMode;
  sessionId?: string;
}

/** Open a brand-new task. Any previous history is genuinely finished. */
export function saveTask(
  repoRoot: string,
  neighborhood: Neighborhood,
  options: SaveOptions = {},
): PersistedTask {
  const previous = loadTask(repoRoot);

  const persisted: PersistedTask = {
    version: 2,
    ...boundaryFields(repoRoot, neighborhood),
    startedAt: new Date().toISOString(),
    challenged: [],
    judged: [],
    reportedUnseen: [],
    justified: [],
    // Forced writes survive a new task deliberately. The code is still in the
    // repo and still was never justified; forgetting that is how a bypassed
    // challenge becomes ordinary-looking history.
    forced: previous?.forced ?? [],
    mode: options.mode ?? 'explicit',
    sessionId: options.sessionId ?? previous?.sessionId,
    lastPromptId: undefined,
    overlay: [],
    graphBuiltAt: new Date().toISOString(),
    graphRevision: (previous?.graphRevision ?? 0) + 1,
  };

  writeTask(repoRoot, persisted);
  return persisted;
}

/**
 * Move the boundary without ending the task.
 *
 * Used when the developer widened what they are doing, or when a rebuild
 * re-derived the same task against fresher code. Challenge history is kept:
 * re-asking about a file we already asked about is exactly the nagging that
 * gets a tool uninstalled.
 */
export function replaceBoundary(
  repoRoot: string,
  neighborhood: Neighborhood,
  options: { resetHistory: boolean; graphBuiltAt?: string } = { resetHistory: false },
): PersistedTask | undefined {
  return updateTask(repoRoot, (task) => ({
    ...task,
    ...boundaryFields(repoRoot, neighborhood),
    challenged: options.resetHistory ? [] : task.challenged,
    justified: options.resetHistory ? [] : task.justified,
    graphBuiltAt: options.graphBuiltAt ?? task.graphBuiltAt,
  }));
}

/** Read the active task, or undefined when there is none. */
export function loadTask(repoRoot: string): PersistedTask | undefined {
  const file = taskPath(repoRoot);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PersistedTask> & {
      version?: number;
    };
    // `judged` was added after version 2 shipped, so a state file written by the
    // previous build is a valid v2 without it. Defaulting here rather than
    // bumping the version keeps every other field intact: the alternative is a
    // migration that throws away a boundary the developer is still working in.
    if (parsed.version === 2) {
      return {
        ...(parsed as PersistedTask),
        judged: parsed.judged ?? [],
        reportedUnseen: parsed.reportedUnseen ?? [],
      };
    }
    // A task written by an older Ichor is still a real task the developer is in
    // the middle of. Fill the new fields rather than dropping their boundary.
    if (parsed.version === 1) {
      return {
        ...(parsed as unknown as PersistedTask),
        version: 2,
        forced: [],
        judged: [],
        reportedUnseen: [],
        mode: 'explicit',
        overlay: [],
        graphRevision: 0,
      };
    }
    return undefined;
  } catch {
    // A corrupt state file must not break the agent — no task means no policing.
    return undefined;
  }
}

export function clearTask(repoRoot: string): void {
  const file = taskPath(repoRoot);
  if (fs.existsSync(file)) fs.rmSync(file);
}

/**
 * Read-modify-write the task atomically.
 *
 * The single mutation path. Returns undefined when there is no task, so callers
 * can treat "nothing to update" and "no task" identically.
 */
export function updateTask(
  repoRoot: string,
  mutate: (task: PersistedTask) => PersistedTask,
): PersistedTask | undefined {
  const task = loadTask(repoRoot);
  if (!task) return undefined;
  const next = mutate(task);
  writeTask(repoRoot, next);
  return next;
}

/** Record that we challenged a file, so a repeat edit is not re-asked. */
export function markChallenged(repoRoot: string, file: string): void {
  updateTask(repoRoot, (task) =>
    task.challenged.includes(file) ? task : { ...task, challenged: [...task.challenged, file] },
  );
}

/**
 * Record that a file reached a verdict — allowed ones included.
 *
 * Called for every intent the hook actually decided, which is what makes an edit
 * Ichor never saw detectable at the end of the turn.
 */
export function markJudged(repoRoot: string, files: string[]): void {
  const fresh = files.filter((f) => f);
  if (fresh.length === 0) return;
  updateTask(repoRoot, (task) => {
    const seen = new Set(task.judged);
    const added = fresh.filter((f) => !seen.has(f));
    return added.length === 0 ? task : { ...task, judged: [...task.judged, ...added] };
  });
}

/**
 * Remember that an unjudged change has been reported, so it is not reported again.
 *
 * Keyed by path AND mtime: a repeat of the same change goes quiet, a genuinely new
 * change to the same file speaks up.
 */
export function markUnseenReported(
  repoRoot: string,
  entries: { file: string; mtimeMs: number }[],
): void {
  if (entries.length === 0) return;
  updateTask(repoRoot, (task) => {
    const kept = task.reportedUnseen.filter((r) => !entries.some((e) => e.file === r.file));
    return { ...task, reportedUnseen: [...kept, ...entries] };
  });
}

/** Grow the boundary after a justified expansion. */
export function markJustified(repoRoot: string, file: string, reason: string): void {
  updateTask(repoRoot, (task) =>
    task.justified.some((j) => j.file === file)
      ? task
      : { ...task, justified: [...task.justified, { file, reason, at: new Date().toISOString() }] },
  );
}

/**
 * A challenged file was written anyway, without ever being justified.
 *
 * Not an error and not blocked — just remembered, so `findDuplicateFlow` never
 * offers it as proof that some later change is unnecessary.
 */
export function markForced(repoRoot: string, file: string): void {
  updateTask(repoRoot, (task) => {
    if (task.forced.some((f) => f.file === file)) return task;
    if (task.justified.some((j) => j.file === file)) return task;
    if (!task.challenged.includes(file)) return task;
    return { ...task, forced: [...task.forced, { file, at: new Date().toISOString() }] };
  });
}

/** Remember what the agent just wrote. Tier two — hints only, never evidence. */
export function recordOverlay(repoRoot: string, files: OverlayFile[]): void {
  if (files.length === 0) return;
  updateTask(repoRoot, (task) => {
    const byPath = new Map(task.overlay.map((o) => [o.path, o]));
    for (const file of files) byPath.set(file.path, file);
    return { ...task, overlay: [...byPath.values()] };
  });
}

/** Rebuild the in-memory shape the classifier expects. */
export function toNeighborhood(task: PersistedTask): Neighborhood {
  const members = new Map<number, NeighborhoodMember>();
  for (const m of task.members) members.set(m.id, m);

  const models = new Map<number, { name: string; viaFunction: string }>();
  task.models.forEach((name, index) => models.set(-1 - index, { name, viaFunction: '' }));

  return {
    task: task.task,
    terms: task.terms,
    anchors: task.anchors,
    members,
    models,
    coreModels: new Set(task.coreModels),
    stats: {
      anchorCount: task.anchors.length,
      memberCount: members.size,
      maxDistance: Math.max(0, ...task.members.map((m) => m.distance)),
      queryCount: 0,
      truncated: false, hubsSkipped: 0,
      durationMs: 0,
    },
  };
}
