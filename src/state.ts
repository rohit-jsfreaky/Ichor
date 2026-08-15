/**
 * On-disk state for the active task.
 *
 * The hook runs before every edit, so it cannot rebuild the neighbourhood each
 * time — `ichor start` computes it once and persists it here, and the hook just
 * reads it. Everything needed to classify without touching ts-morph again.
 *
 * Lives in `.ichor/` in the repo, which should be gitignored by `ichor init`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Anchor } from './scope/anchors.js';
import type { Neighborhood, NeighborhoodMember } from './scope/neighborhood.js';

export const STATE_DIR = '.ichor';
export const TASK_FILE = 'task.json';

export interface PersistedTask {
  version: 1;
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
  /** Files the developer or Judge approved — the boundary after it grew. */
  justified: { file: string; reason: string; at: string }[];
}

export function stateDir(repoRoot: string): string {
  return path.join(repoRoot, STATE_DIR);
}

export function taskPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), TASK_FILE);
}

export function saveTask(repoRoot: string, neighborhood: Neighborhood): PersistedTask {
  const persisted: PersistedTask = {
    version: 1,
    task: neighborhood.task,
    startedAt: new Date().toISOString(),
    repoRoot,
    terms: neighborhood.terms,
    anchors: neighborhood.anchors,
    members: [...neighborhood.members.values()],
    models: [...neighborhood.models.values()].map((m) => m.name),
    coreModels: [...neighborhood.coreModels],
    challenged: [],
    justified: [],
  };

  fs.mkdirSync(stateDir(repoRoot), { recursive: true });
  fs.writeFileSync(taskPath(repoRoot), JSON.stringify(persisted, null, 2), 'utf8');
  return persisted;
}

/** Read the active task, or undefined when there is none. */
export function loadTask(repoRoot: string): PersistedTask | undefined {
  const file = taskPath(repoRoot);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedTask;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    // A corrupt state file must not break the agent — no task means no policing.
    return undefined;
  }
}

export function clearTask(repoRoot: string): void {
  const file = taskPath(repoRoot);
  if (fs.existsSync(file)) fs.rmSync(file);
}

/** Record that we challenged a file, so a repeat edit is not re-asked. */
export function markChallenged(repoRoot: string, file: string): void {
  const task = loadTask(repoRoot);
  if (!task || task.challenged.includes(file)) return;
  task.challenged.push(file);
  fs.writeFileSync(taskPath(repoRoot), JSON.stringify(task, null, 2), 'utf8');
}

/** Grow the boundary after a justified expansion. */
export function markJustified(repoRoot: string, file: string, reason: string): void {
  const task = loadTask(repoRoot);
  if (!task) return;
  if (task.justified.some((j) => j.file === file)) return;
  task.justified.push({ file, reason, at: new Date().toISOString() });
  fs.writeFileSync(taskPath(repoRoot), JSON.stringify(task, null, 2), 'utf8');
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
      durationMs: 0,
    },
  };
}
