/**
 * Rebuilding the compiled graph between turns.
 *
 * Measured: analysing this repo takes ~2.8s and grows with repo size, so this
 * can never run inline on a developer's keystroke. It runs detached, triggered
 * when the agent stops talking — the one moment in a session when nobody is
 * waiting, because the human is reading the answer.
 *
 * Everything here fails open. A refresh that cannot run leaves the previous
 * boundary in place: Ichor then reasons about a slightly old codebase, which is
 * exactly what it does today, and far better than breaking the session.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeRepo } from '../extract/analyze.js';
import { analyzeIncremental, type FileCache } from '../extract/incremental.js';
import { writeGraph } from '../graph/write.js';
import { GraphClient, configFromEnv } from '../graph/client.js';
import { findAnchors } from '../scope/anchors.js';
import { buildNeighborhood } from '../scope/neighborhood.js';
import { buildNameIndex, type NameIndex } from '../scope/taskSwitch.js';
import { loadTask, replaceBoundary, stateDir, updateTask, writeAtomic } from '../state.js';
import type { GraphFacts } from '../extract/types.js';

const FACTS_FILE = 'facts.json';
const INDEX_FILE = 'index.json';
const LOCK_FILE = 'refresh.lock';
const CACHE_FILE = 'incremental.json';

/** A lock older than this belonged to a process that died. */
const LOCK_STALE_MS = 10 * 60_000;

/** Never rebuild more often than this, however chatty the session. */
const THROTTLE_MS = 30_000;

interface FactsEnvelope {
  version: 1;
  builtAt: string;
  facts: GraphFacts;
}

const factsPath = (repoRoot: string) => path.join(stateDir(repoRoot), FACTS_FILE);
const indexPath = (repoRoot: string) => path.join(stateDir(repoRoot), INDEX_FILE);
const lockPath = (repoRoot: string) => path.join(stateDir(repoRoot), LOCK_FILE);
const cachePath = (repoRoot: string) => path.join(stateDir(repoRoot), CACHE_FILE);

export function loadFacts(repoRoot: string): GraphFacts | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(factsPath(repoRoot), 'utf8')) as FactsEnvelope;
    return parsed.version === 1 ? parsed.facts : undefined;
  } catch {
    return undefined;
  }
}

export function loadIndex(repoRoot: string): NameIndex | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(repoRoot), 'utf8')) as NameIndex;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- locking

function acquireLock(repoRoot: string): boolean {
  const file = lockPath(repoRoot);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const held = JSON.parse(raw) as { startedAt?: string };
    const age = Date.now() - Date.parse(held.startedAt ?? '');
    if (Number.isFinite(age) && age < LOCK_STALE_MS) return false;
  } catch {
    // No lock, or an unreadable one. Either way it is ours to take.
  }
  writeAtomic(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return true;
}

function releaseLock(repoRoot: string): void {
  try {
    fs.rmSync(lockPath(repoRoot));
  } catch {
    /* a missing lock is not a problem */
  }
}

// ------------------------------------------------------------ staleness

/**
 * Paths git reports as modified.
 *
 * This is what catches edits Ichor's hook never saw: a file written by a shell
 * command, a codegen script, or the developer's own editor. Returns an empty
 * list for a non-git repo, where the overlay is the only signal we have.
 */
function gitChangedPaths(repoRoot: string): string[] {
  try {
    const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 3_000,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter((p) => /\.(ts|tsx)$/.test(p) || p.endsWith('.prisma'));
  } catch {
    return [];
  }
}

export interface StalenessReason {
  stale: boolean;
  why: string;
}

/** Is the compiled graph behind the code, and are we allowed to rebuild yet? */
export function needsRefresh(repoRoot: string): StalenessReason {
  const task = loadTask(repoRoot);
  if (!task) return { stale: false, why: 'no active task' };
  if (!task.graphBuiltAt) return { stale: true, why: 'graph has never been built' };

  const builtAt = Date.parse(task.graphBuiltAt);
  if (Number.isFinite(builtAt) && Date.now() - builtAt < THROTTLE_MS) {
    return { stale: false, why: 'rebuilt moments ago' };
  }

  const touchedByAgent = task.overlay.filter((o) => Date.parse(o.at) > builtAt);
  if (touchedByAgent.length > 0) {
    return { stale: true, why: `${touchedByAgent.length} file(s) written by the agent` };
  }

  for (const rel of gitChangedPaths(repoRoot)) {
    try {
      if (fs.statSync(path.join(repoRoot, rel)).mtimeMs > builtAt) {
        return { stale: true, why: `${rel} changed outside the agent` };
      }
    } catch {
      // Deleted since git reported it — that is a change too.
      return { stale: true, why: `${rel} was removed` };
    }
  }

  return { stale: false, why: 'graph matches the code' };
}

// ------------------------------------------------------------- rebuilding

export interface RefreshResult {
  ran: boolean;
  why: string;
  members?: number;
}

/**
 * Read the codebase, write the graph, and cache what a prompt needs.
 *
 * The two cached files exist so that classifying a prompt costs a file read
 * instead of a 3-second analysis: `facts.json` is what `findAnchors` needs to
 * draw a boundary, and `index.json` is the flattened name list that decides
 * whether a prompt still points at the current one.
 */
export async function analyzeAndPersist(repoRoot: string, client: GraphClient): Promise<GraphFacts> {
  const builtAt = new Date().toISOString();

  // Re-read only what changed since last time. This falls back to a full read on
  // its own whenever the cache cannot be trusted to give an identical answer —
  // no cache, a deleted file, or too much of the tree affected to be worth it.
  const previous = loadFacts(repoRoot) ?? undefined;
  const result = analyzeIncremental(repoRoot, previous, loadCache(repoRoot));
  const facts = result.facts;

  await writeGraph(client, facts);

  writeAtomic(
    factsPath(repoRoot),
    `${JSON.stringify({ version: 1, builtAt, facts } satisfies FactsEnvelope)}\n`,
  );
  writeAtomic(indexPath(repoRoot), `${JSON.stringify(buildNameIndex(facts, builtAt))}\n`);
  writeAtomic(cachePath(repoRoot), `${JSON.stringify(result.cache)}\n`);
  return facts;
}

/** The previous run's file hashes and symbol tables, if they are still usable. */
function loadCache(repoRoot: string): FileCache | undefined {
  try {
    return JSON.parse(fs.readFileSync(cachePath(repoRoot), 'utf8')) as FileCache;
  } catch {
    return undefined;
  }
}

/**
 * Re-analyse the repo, rewrite the graph, and re-derive the current boundary.
 *
 * The boundary is always re-derived rather than carried over: node ids are
 * hashes of `<file>#<name>`, so a rename or a move produces different ids and
 * the stored members would silently point at nothing.
 */
export async function refresh(repoRoot: string, options: { force?: boolean } = {}): Promise<RefreshResult> {
  const task = loadTask(repoRoot);
  if (!task) return { ran: false, why: 'no active task' };

  if (!options.force) {
    const staleness = needsRefresh(repoRoot);
    if (!staleness.stale) return { ran: false, why: staleness.why };
  }

  if (!acquireLock(repoRoot)) return { ran: false, why: 'another refresh is running' };

  const client = new GraphClient(configFromEnv());
  try {
    const builtAt = new Date().toISOString();
    const facts = await analyzeAndPersist(repoRoot, client);

    // Re-derive the boundary against the fresh graph, keeping challenge history:
    // this is the same job, just described by newer code.
    const { anchors, terms } = findAnchors(facts, task.task);
    const neighborhood = await buildNeighborhood(client, task.task, anchors, terms);
    replaceBoundary(repoRoot, neighborhood, { resetHistory: false, graphBuiltAt: builtAt });

    // The revision is bumped only now, after the graph is actually written, so
    // nobody can observe a revision that promises more than the graph holds.
    updateTask(repoRoot, (t) => ({ ...t, graphRevision: t.graphRevision + 1, overlay: [] }));

    return { ran: true, why: 'rebuilt', members: neighborhood.members.size };
  } finally {
    await client.close().catch(() => undefined);
    releaseLock(repoRoot);
  }
}

// -------------------------------------------------------------- spawning

/**
 * Resolve the compiled CLI next to this module.
 *
 * Deliberately the built JavaScript: node starts in 0.08s where tsx takes 1.46s,
 * and a background process that spends most of its life booting a TypeScript
 * loader is a background process that never finishes before the next turn.
 */
function compiledCli(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, '..', 'cli.js');
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Kick off a rebuild and return immediately.
 *
 * Detached with no stdio: the parent is a hook the agent is waiting on, so this
 * must not hold a pipe open or the agent stalls until the rebuild finishes.
 */
export function spawnRefresh(repoRoot: string): { spawned: boolean; why: string } {
  const cli = compiledCli();
  if (!cli) return { spawned: false, why: 'compiled CLI not found (running from source?)' };

  try {
    const child = spawn(process.execPath, [cli, 'refresh', '--repo', repoRoot], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { spawned: true, why: `pid ${child.pid ?? '?'}` };
  } catch (error) {
    return { spawned: false, why: (error as Error).message };
  }
}
