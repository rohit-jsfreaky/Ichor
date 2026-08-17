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

/**
 * Is a rebuild holding the database right now?
 *
 * Exported because the PROMPT path needs it, and that is the whole of bug 6.
 * Finishing a turn that edited files starts a rebuild; prompt again within a few
 * seconds and the boundary draw contends with it, overruns the 20-second ceiling,
 * and Ichor protects nothing for that turn — which was observed three times in one
 * session and is invisible unless you read the log.
 *
 * The two are not competing for a scarce resource by accident. They are the same
 * process design: rebuild when the human is reading, draw when the human is
 * typing. When they do overlap, one of them has to give, and it should be the one
 * whose work is still valid a second later.
 */
export function refreshInProgress(repoRoot: string): boolean {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath(repoRoot), 'utf8')) as { startedAt?: string };
    const age = Date.now() - Date.parse(held.startedAt ?? '');
    // A lock older than this belonged to a process that died, and waiting on a
    // dead rebuild would be worse than ignoring it.
    return Number.isFinite(age) && age < LOCK_STALE_MS;
  } catch {
    return false;
  }
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
 * Paths git reports as modified, relative to the WATCHED root.
 *
 * This is what catches edits Ichor's hook never saw: a file written by a shell
 * command, a codegen script, or the developer's own editor. Returns an empty
 * list for a non-git repo, where the overlay is the only signal we have.
 *
 * THE PREFIX MATTERS, and getting it wrong is silent.
 *
 * `git status` reports paths relative to the GIT ROOT, not to the directory it
 * ran in. When those are the same it makes no difference, and every suite here
 * ran that way. When they differ — `ichor init` inside `backend/` of a monorepo,
 * an entirely ordinary thing to do — every path comes back with `backend/` on the
 * front, and the callers below join it onto the repo root a second time. The stat
 * then fails, the failure is read as "the file was deleted", and a rebuild is
 * triggered after every single turn, forever.
 *
 * Nothing failed while that was true. It surfaced because one test compared a
 * reported path against the one it had just written, in a repo that happens to be
 * a subdirectory — the single arrangement no other suite used.
 */
export function gitChangedPaths(repoRoot: string): string[] {
  try {
    const run = (args: string[]) =>
      spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 3_000 });

    // Empty when the watched root IS the git root, which is the common case.
    const prefixResult = run(['rev-parse', '--show-prefix']);
    if (prefixResult.status !== 0) return [];
    const prefix = (prefixResult.stdout ?? '').trim();

    // `-- .` keeps a monorepo's other packages out of the answer entirely. They
    // are not this task's repository and never were.
    const result = run(['status', '--porcelain', '--untracked-files=all', '--', '.']);
    if (result.status !== 0 || !result.stdout) return [];

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      // A rename reads `old -> new`; the new path is the one that exists now.
      .map((p) => (p.includes(' -> ') ? p.slice(p.lastIndexOf(' -> ') + 4) : p))
      // Quoted when the path contains unusual characters.
      .map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
      .filter((p) => p.length > 0)
      .filter((p) => !prefix || p.startsWith(prefix))
      .map((p) => (prefix ? p.slice(prefix.length) : p))
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
        // "changed since the graph was built", NOT "changed outside the agent".
        //
        // git cannot tell you who wrote a file, and the old wording claimed it
        // could. It was wrong in an ordinary case: a challenged edit is
        // deliberately kept out of the overlay, so a file the agent definitely
        // wrote reaches this branch and was then reported as someone else's work.
        // `unseenEdits` in hook/stop.ts is the thing that can answer provenance,
        // because it knows what Ichor actually judged.
        return { stale: true, why: `${rel} changed since the graph was built` };
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
  const cache = loadCache(repoRoot);
  const result = analyzeIncremental(repoRoot, previous, cache);
  const facts = result.facts;

  // The ledger from the last write is what turns a refresh into "write the ten
  // edges that changed" instead of all thirteen thousand.
  const written = await writeGraph(client, facts, {
    previous,
    previousEdges: cache?.edges,
  });

  writeAtomic(
    factsPath(repoRoot),
    `${JSON.stringify({ version: 1, builtAt, facts } satisfies FactsEnvelope)}\n`,
  );
  writeAtomic(indexPath(repoRoot), `${JSON.stringify(buildNameIndex(facts, builtAt))}\n`);
  // The ledger goes in with the file hashes: both answer "what did we do last
  // time", and both are useless if they disagree with each other.
  writeAtomic(
    cachePath(repoRoot),
    `${JSON.stringify({ ...result.cache, edges: written.edges })}\n`,
  );
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
