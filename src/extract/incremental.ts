/**
 * Re-read only what changed.
 *
 * A full read of a 1,362-file product costs about 17 seconds, and a refresh
 * between agent turns repeats all of it to account for two edited files. Almost
 * every one of those seconds re-derives facts that cannot have changed.
 *
 * THE PART THAT MAKES THIS HARD
 *
 * Resolution is a cross-file question. `import { send } from './email'` is only
 * answerable with `./email`'s export table, so parsing one file in isolation
 * cannot resolve anything it imports. That is why a previous run's SYMBOL TABLES
 * are cached alongside the file hashes: the changed files are re-parsed, every
 * other file's table is replayed from cache, and the resolver sees a complete
 * picture built almost entirely from work already done.
 *
 * WHAT COUNTS AS AFFECTED
 *
 * Not just the edited files. If `email.ts` changed, every file importing it may
 * now resolve differently — a renamed export turns a real edge into a dangling
 * one — so importers are re-parsed too, transitively. The import graph is
 * already in the facts, so this costs nothing to compute.
 *
 * If that closure covers most of the repository, incremental work is pointless
 * and a full read is both simpler and faster. That case falls back rather than
 * grinding through a slower path to the same answer.
 *
 * SAFETY
 *
 * The rule is absolute: an incremental result must equal a full read of the
 * same tree, edge for edge. `scripts/incremental-test.ts` asserts exactly that,
 * because a graph that is subtly stale is worse than no graph — every answer
 * still looks confident.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { analyzeRepo } from './analyze.js';
import type { FileSymbols, ImportBinding, ExportBinding } from './symbols.js';
import type { GraphFacts } from './types.js';

/** Past this share of the repo, re-reading everything is the cheaper path. */
const FULL_READ_THRESHOLD = 0.5;

export interface FileCache {
  version: 2;
  /** repo-relative path -> content hash */
  hashes: Record<string, string>;
  /** repo-relative path -> its symbol table, so importers can resolve without a re-parse */
  symbols: Record<string, SerialisedSymbols>;
}

interface SerialisedSymbols {
  locals: [string, string][];
  imports: [string, ImportBinding][];
  exports: [string, ExportBinding][];
  starExports: string[];
}

const hashOf = (content: string): string =>
  crypto.createHash('sha1').update(content).digest('base64').slice(0, 16);

export function buildCache(root: string, facts: GraphFacts): FileCache {
  const hashes: Record<string, string> = {};
  const symbols: Record<string, SerialisedSymbols> = {};

  for (const file of facts.files) {
    try {
      hashes[file.path] = hashOf(fs.readFileSync(path.join(root, file.path), 'utf8'));
    } catch {
      // Vanished between the read and now — treated as changed next time.
    }
  }
  for (const [file, table] of facts.symbols ?? []) {
    symbols[file] = {
      locals: [...table.locals],
      imports: [...table.imports],
      exports: [...table.exports],
      starExports: table.starExports,
    };
  }

  return { version: 2, hashes, symbols };
}

function reviveSymbols(cache: FileCache): Map<string, FileSymbols> {
  const tables = new Map<string, FileSymbols>();
  for (const [file, s] of Object.entries(cache.symbols)) {
    tables.set(file, {
      file,
      locals: new Map(s.locals),
      imports: new Map(s.imports),
      exports: new Map(s.exports),
      starExports: s.starExports,
    });
  }
  return tables;
}

/** Every source file on disk now, repo-relative and POSIX. */
function sourcesOnDisk(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        const rel = path.relative(root, full).replace(/\\/g, '/');
        try {
          found.set(rel, hashOf(fs.readFileSync(full, 'utf8')));
        } catch {
          /* unreadable — skip, it will look changed next time */
        }
      }
    }
  };
  walk(root);
  return found;
}

export interface IncrementalResult {
  facts: GraphFacts;
  cache: FileCache;
  /** How the answer was reached — reported, never guessed at by the caller. */
  mode: 'incremental' | 'full';
  filesReparsed: number;
  filesTotal: number;
}

/**
 * Analyse a repository, re-reading only what changed since `cache`.
 *
 * Falls back to a full read whenever the cache cannot be trusted to produce an
 * identical answer — no cache, a different shape, or too much of the tree
 * affected.
 */
export function analyzeIncremental(
  root: string,
  previous: GraphFacts | undefined,
  cache: FileCache | undefined,
): IncrementalResult {
  const full = (): IncrementalResult => {
    const facts = analyzeRepo(root);
    return {
      facts,
      cache: buildCache(root, facts),
      mode: 'full',
      filesReparsed: facts.files.length,
      filesTotal: facts.files.length,
    };
  };

  if (!previous || !cache || cache.version !== 2) return full();

  const onDisk = sourcesOnDisk(root);
  const known = new Set(previous.files.map((f) => f.path));

  const changed = new Set<string>();
  for (const [file, hash] of onDisk) {
    if (cache.hashes[file] !== hash) changed.add(file);
  }
  // A deleted file changes the answer as surely as an edited one.
  const deleted = [...known].filter((f) => !onDisk.has(f));
  if (deleted.length > 0) return full();

  if (changed.size === 0) {
    return {
      facts: previous,
      cache,
      mode: 'incremental',
      filesReparsed: 0,
      filesTotal: onDisk.size,
    };
  }

  // Importers, transitively: a renamed export turns their edges into dangling
  // ones, and only a re-parse produces the replacements.
  const importersOf = new Map<string, string[]>();
  const pathByKey = new Map(previous.files.map((f) => [f.key, f.path]));
  for (const edge of previous.imports) {
    const from = pathByKey.get(edge.fromFileKey);
    const to = pathByKey.get(edge.toFileKey);
    if (!from || !to) continue;
    (importersOf.get(to) ?? importersOf.set(to, []).get(to)!).push(from);
  }

  const affected = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const file = queue.pop()!;
    for (const importer of importersOf.get(file) ?? []) {
      if (!affected.has(importer)) {
        affected.add(importer);
        queue.push(importer);
      }
    }
  }

  if (affected.size / Math.max(onDisk.size, 1) > FULL_READ_THRESHOLD) return full();

  // Re-parse only the affected files, resolving against every file's table.
  const fresh = analyzeRepo(root, {
    only: [...affected],
    knownSymbols: reviveSymbols(cache),
  });

  const facts = mergeFacts(previous, fresh, affected);
  return {
    facts,
    cache: buildCache(root, facts),
    mode: 'incremental',
    filesReparsed: affected.size,
    filesTotal: onDisk.size,
  };
}

/**
 * Replace everything belonging to the re-parsed files, keep the rest.
 *
 * Edges are keyed to the file they were FOUND in, which is why every edge type
 * carries a `file`. Dropping by that and appending the fresh set is what makes
 * the result identical to a full read rather than merely close to it.
 */
function mergeFacts(previous: GraphFacts, fresh: GraphFacts, reparsed: Set<string>): GraphFacts {
  const kept = <T extends { file: string }>(rows: T[]) => rows.filter((r) => !reparsed.has(r.file));

  const files = [
    ...previous.files.filter((f) => !reparsed.has(f.path)),
    ...fresh.files,
  ];
  const functions = [...kept(previous.functions), ...fresh.functions];
  const types = [...kept(previous.types), ...fresh.types];

  const fileKeyToPath = new Map(files.map((f) => [f.key, f.path]));
  const imports = [
    ...previous.imports.filter((i) => {
      const from = fileKeyToPath.get(i.fromFileKey);
      return from !== undefined && !reparsed.has(from);
    }),
    ...fresh.imports,
  ];

  const merged: GraphFacts = {
    ...previous,
    files,
    functions,
    types,
    routes: [...kept(previous.routes), ...fresh.routes],
    // Prisma models are read from the schema every time — cheap, and a schema
    // edit is not a TypeScript file change.
    models: fresh.models,
    fields: fresh.fields,
    calls: [...kept(previous.calls), ...fresh.calls],
    references: [...kept(previous.references), ...fresh.references],
    touches: [...kept(previous.touches), ...fresh.touches],
    imports,
    symbols: fresh.symbols,
    stats: { ...fresh.stats, filesScanned: files.length },
  };

  return dropDanglingEdges(merged);
}

/**
 * Drop edges whose endpoints no longer exist.
 *
 * An unchanged file can point at a function that a changed file has just
 * renamed or removed. A full read never emits such an edge; this is what keeps
 * the incremental answer identical rather than merely similar. HydraDB also
 * rejects an entire write when one endpoint is missing, so leaving them in
 * would fail the whole refresh.
 */
function dropDanglingEdges(facts: GraphFacts): GraphFacts {
  const functionKeys = new Set(facts.functions.map((f) => f.key));
  const typeKeys = new Set(facts.types.map((t) => t.key));
  const modelKeys = new Set(facts.models.map((m) => m.key));
  const fileKeys = new Set(facts.files.map((f) => f.key));

  const before =
    facts.calls.length + facts.references.length + facts.touches.length +
    facts.routes.length + facts.imports.length;

  const calls = facts.calls.filter((c) => functionKeys.has(c.fromKey) && functionKeys.has(c.toKey));
  const references = facts.references.filter(
    (r) => (functionKeys.has(r.fromKey) || typeKeys.has(r.fromKey)) && typeKeys.has(r.toKey),
  );
  const touches = facts.touches.filter((t) => functionKeys.has(t.fromKey) && modelKeys.has(t.modelKey));
  const routes = facts.routes.filter((r) => functionKeys.has(r.handlerKey));
  const imports = facts.imports.filter(
    (i) => fileKeys.has(i.fromFileKey) && fileKeys.has(i.toFileKey),
  );

  const after = calls.length + references.length + touches.length + routes.length + imports.length;

  return {
    ...facts,
    calls,
    references,
    touches,
    routes,
    imports,
    stats: { ...facts.stats, edgesDropped: facts.stats.edgesDropped + (before - after) },
  };
}
