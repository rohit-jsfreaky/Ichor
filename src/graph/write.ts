/**
 * Write extracted facts into HydraDB.
 *
 * The only module that mutates the graph. Everything here is shaped by three
 * hard constraints of the engine (see CLAUDE.md):
 *
 *  - ~200 writes/sec and commits serialise, so everything is batched. Writing
 *    row-at-a-time would take minutes on a real repo.
 *  - Batches must be `UNWIND $rows` over Bolt with a parameter holding a list
 *    of maps. An inline list is rejected.
 *  - A vertex upsert must be `MERGE` by id and THEN `SET`. Folding properties
 *    into the MERGE pattern is rejected, because the pattern is the identity
 *    being matched on.
 *
 * Ids always cross the wire through gInt(), never as plain numbers.
 */

import { GraphClient, gInt } from './client.js';
import { IdRegistry } from '../ids.js';
import type { GraphFacts } from '../extract/types.js';

/**
 * Rows per statement.
 *
 * Each UNWIND is one commit regardless of how many rows it carries, so bigger
 * batches mean proportionally fewer commits. Kept well below the point where a
 * single Bolt message gets unwieldy.
 */
const BATCH_SIZE = 500;

export interface WriteStats {
  nodesWritten: number;
  edgesWritten: number;
  statements: number;
  /** Nodes removed because the code they described is gone. */
  nodesPruned: number;
  /** Stale nodes left in place because removing them would have hung. */
  stalePruneSkipped: number;
  durationMs: number;
}

export interface WriteOptions {
  /** Called with progress messages so a CLI can show what is happening. */
  onProgress?: (message: string) => void;
}

export async function writeGraph(
  client: GraphClient,
  facts: GraphFacts,
  options: WriteOptions = {},
): Promise<WriteStats> {
  const started = Date.now();
  const progress = options.onProgress ?? (() => {});
  const ids = new IdRegistry();

  let nodesWritten = 0;
  let edgesWritten = 0;
  let statements = 0;

  /** Run one UNWIND per chunk. */
  const runBatched = async <T>(rows: T[], cypher: string): Promise<void> => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await client.run(cypher, { rows: rows.slice(i, i + BATCH_SIZE) });
      statements++;
    }
  };


  // ---- nodes ------------------------------------------------------------
  progress(`writing ${facts.files.length} files`);
  await runBatched(
    facts.files.map((f) => ({ vertex: gInt(ids.idFor(f.key)), path: f.path })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:File, n.path = row.path`,
  );
  nodesWritten += facts.files.length;

  progress(`writing ${facts.functions.length} functions`);
  await runBatched(
    facts.functions.map((fn) => ({
      vertex: gInt(ids.idFor(fn.key)),
      name: fn.name,
      file: fn.file,
      line: gInt(fn.line),
      exported: fn.exported,
      isComponent: fn.isComponent,
      isTest: fn.isTest,
    })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex})
       SET n:Function, n.name = row.name, n.file = row.file, n.line = row.line,
           n.exported = row.exported, n.isComponent = row.isComponent, n.isTest = row.isTest`,
  );
  nodesWritten += facts.functions.length;

  progress(`writing ${facts.types.length} types`);
  await runBatched(
    facts.types.map((t) => ({
      vertex: gInt(ids.idFor(t.key)),
      name: t.name,
      file: t.file,
      line: t.line,
      kind: t.kind,
      exported: t.exported,
    })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex})
       SET n:Type, n.name = row.name, n.file = row.file, n.line = row.line,
           n.kind = row.kind, n.exported = row.exported`,
  );
  nodesWritten += facts.types.length;

  progress(`writing ${facts.routes.length} routes`);
  await runBatched(
    facts.routes.map((r) => ({
      vertex: gInt(ids.idFor(r.key)),
      method: r.method,
      path: r.path,
      file: r.file,
      line: gInt(r.line),
    })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex})
       SET n:Route, n.method = row.method, n.path = row.path, n.file = row.file, n.line = row.line`,
  );
  nodesWritten += facts.routes.length;

  progress(`writing ${facts.models.length} models and ${facts.fields.length} fields`);
  await runBatched(
    facts.models.map((m) => ({ vertex: gInt(ids.idFor(m.key)), name: m.name })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Model, n.name = row.name`,
  );
  await runBatched(
    facts.fields.map((f) => ({
      vertex: gInt(ids.idFor(f.key)),
      name: f.name,
      model: f.model,
      type: f.type,
      isUnique: f.isUnique,
      isId: f.isId,
    })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex})
       SET n:Field, n.name = row.name, n.model = row.model, n.type = row.type,
           n.isUnique = row.isUnique, n.isId = row.isId`,
  );
  nodesWritten += facts.models.length + facts.fields.length;

  // ---- edges ------------------------------------------------------------
  //
  // MERGE on a deterministic edge id, not CREATE.
  //
  // This is what lets a rebuild skip deleting anything. `DETACH DELETE` by label
  // runs at roughly 96ms per node on this engine and is capped by a 30s query
  // timeout, so wiping a real repository's graph is simply not possible — a
  // 2,265-function codebase times out, and there is no batched delete in the
  // Cypher subset to fall back on (`UNWIND … DETACH DELETE` and
  // `WITH n LIMIT n` are both rejected).
  //
  // Since node ids are content-derived, MERGE upserts every node, and giving each
  // edge its own derived id makes the relationships upsert too — verified: two
  // identical passes leave 49 edges, not 98. A rebuild is now a write, not a
  // delete-then-write.
  const edge = (label: string, from: string, to: string) =>
    `UNWIND $rows AS row
       MATCH (s:${from} {id: row.source_vertex}), (d:${to} {id: row.destination_vertex})
       MERGE (s)-[:${label} {id: row.edge_id}]->(d)`;

  /** One stable id per relationship, so the same edge is never written twice. */
  const edgeRow = (label: string, fromKey: string, toKey: string) => ({
    source_vertex: gInt(ids.idFor(fromKey)),
    destination_vertex: gInt(ids.idFor(toKey)),
    edge_id: gInt(ids.idFor(`edge:${label}:${fromKey}->${toKey}`)),
  });

  progress(`writing ${facts.calls.length} CALLS edges`);
  await runBatched(
    facts.calls.map((c) => edgeRow('CALLS', c.fromKey, c.toKey)),
    edge('CALLS', 'Function', 'Function'),
  );
  edgesWritten += facts.calls.length;

  progress(`writing ${facts.touches.length} TOUCHES edges`);
  await runBatched(
    facts.touches.map((t) => edgeRow('TOUCHES', t.fromKey, t.modelKey)),
    edge('TOUCHES', 'Function', 'Model'),
  );
  edgesWritten += facts.touches.length;

  progress('writing HANDLED_BY, HAS_FIELD, DECLARES, IMPORTS edges');
  await runBatched(
    facts.routes.map((r) => edgeRow('HANDLED_BY', r.key, r.handlerKey)),
    edge('HANDLED_BY', 'Route', 'Function'),
  );
  edgesWritten += facts.routes.length;

  const modelKeyByName = new Map(facts.models.map((m) => [m.name, m.key]));
  const fieldEdges = facts.fields
    .map((f) => {
      const modelKey = modelKeyByName.get(f.model);
      return modelKey ? edgeRow('HAS_FIELD', modelKey, f.key) : undefined;
    })
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  await runBatched(fieldEdges, edge('HAS_FIELD', 'Model', 'Field'));
  edgesWritten += fieldEdges.length;

  // A file DECLARES the functions defined in it — lets us ask "what else lives
  // in this file", which matters when an agent edits a neighbouring symbol.
  const fileKeyByPath = new Map(facts.files.map((f) => [f.path, f.key]));
  const declareEdges = facts.functions
    .map((fn) => {
      const fileKey = fileKeyByPath.get(fn.file);
      return fileKey ? edgeRow('DECLARES', fileKey, fn.key) : undefined;
    })
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  await runBatched(declareEdges, edge('DECLARES', 'File', 'Function'));
  edgesWritten += declareEdges.length;

  await runBatched(
    facts.imports.map((i) => edgeRow('IMPORTS', i.fromFileKey, i.toFileKey)),
    edge('IMPORTS', 'File', 'File'),
  );
  edgesWritten += facts.imports.length;

  // A file DECLARES its types too, so "what else lives here" covers both.
  const typeDeclareEdges = facts.types
    .map((t) => {
      const fileKey = fileKeyByPath.get(t.file);
      return fileKey ? edgeRow('DECLARES', fileKey, t.key) : undefined;
    })
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  await runBatched(typeDeclareEdges, edge('DECLARES', 'File', 'Type'));
  edgesWritten += typeDeclareEdges.length;

  // Split by what the reference starts FROM. A type mention inside a function
  // body is `Function -> Type`; one inside an interface body — `interface Order
  // { vendor: Vendor }` — is `Type -> Type`, and is just as real. HydraDB checks
  // the label on both ends of a MERGE, so sending them down one query rejects
  // the whole batch with "endpoint vertex does not have label Function".
  const typeKeys = new Set(facts.types.map((t) => t.key));
  const fromTypes = facts.references.filter((r) => typeKeys.has(r.fromKey));
  const fromFunctions = facts.references.filter((r) => !typeKeys.has(r.fromKey));

  progress(`writing ${facts.references.length} REFERENCES edges`);
  await runBatched(
    fromFunctions.map((r) => edgeRow('REFERENCES', r.fromKey, r.toKey)),
    edge('REFERENCES', 'Function', 'Type'),
  );
  await runBatched(
    fromTypes.map((r) => edgeRow('REFERENCES', r.fromKey, r.toKey)),
    edge('REFERENCES', 'Type', 'Type'),
  );
  edgesWritten += facts.references.length;

  // ---- prune --------------------------------------------------------------
  //
  // Everything above upserts, so code that still exists is now correct. What is
  // left is the opposite problem: nodes for code that has been DELETED since the
  // last build. They would linger and — worse — could be cited as an "existing
  // path" for a function nobody can call any more.
  //
  // Deleting is expensive here (~96ms a node, 30s statement ceiling), so this is
  // deliberately bounded. A handful of removals between turns is the normal case
  // and costs a second. A huge stale set means something else happened — usually
  // pointing Ichor at a different repository — and that is reported rather than
  // attempted, because attempting it would hang.
  await claimGraph(client, facts.repoRoot);

  const pruned = await prune(client, facts, progress);
  statements += pruned.statements;

  return {
    nodesWritten,
    edgesWritten,
    statements,
    nodesPruned: pruned.removed,
    stalePruneSkipped: pruned.skipped,
    durationMs: Date.now() - started,
  };
}

/** How many stale nodes we are willing to remove before saying it is too many. */
const MAX_PRUNE = 150;

/** Fixed id for the single marker node recording which repo this graph holds. */
const GRAPH_MARKER_ID = 1;

/**
 * Refuse to write a second repository into the same graph.
 *
 * One local HydraDB holds one codebase. Nodes are keyed by repo-RELATIVE path,
 * so two repos with a `src/lib/db.ts` each collide onto the same node, and the
 * leftovers from the previous repo are far too many to delete inside the query
 * timeout. The result is a graph that answers confidently about a mixture of two
 * codebases — a wrong answer, which is worse than a crash (rule 2).
 */
async function claimGraph(client: GraphClient, repoRoot: string): Promise<void> {
  const normalised = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');

  const rows = await client.run(
    'MATCH (m:IchorGraph) RETURN m.repoRoot AS repoRoot LIMIT 1',
    {},
  );
  const held = rows.records[0]?.get('repoRoot');

  if (typeof held === 'string' && held && held !== normalised) {
    throw new Error(
      `This HydraDB already holds the graph for ${held}.
` +
        `Ichor keeps one codebase per database, and the old one cannot be removed ` +
        `in place — deletes are far too slow on this engine.

` +
        `For a clean graph:  ichor down --wipe && ichor up`,
    );
  }

  // Wrapped in UNWIND because a bare `MERGE … SET` is rejected — "MERGE with
  // following clauses is not executable" — while the same pair inside an UNWIND
  // is fine, which is how every node in this file is written.
  await client.run(
    'UNWIND $rows AS row MERGE (m {id: row.vertex}) SET m:IchorGraph, m.repoRoot = row.repoRoot',
    { rows: [{ vertex: gInt(GRAPH_MARKER_ID), repoRoot: normalised }] },
  );
}

async function prune(
  client: GraphClient,
  facts: GraphFacts,
  progress: (message: string) => void,
): Promise<{ removed: number; skipped: number; statements: number }> {
  const ids = new IdRegistry();
  const expected = new Map<string, Set<string>>([
    ['File', new Set(facts.files.map((f) => String(ids.idFor(f.key))))],
    ['Function', new Set(facts.functions.map((f) => String(ids.idFor(f.key))))],
    ['Route', new Set(facts.routes.map((r) => String(ids.idFor(r.key))))],
    ['Model', new Set(facts.models.map((m) => String(ids.idFor(m.key))))],
    ['Field', new Set(facts.fields.map((f) => String(ids.idFor(f.key))))],
    ['Type', new Set(facts.types.map((t) => String(ids.idFor(t.key))))],
  ]);

  let removed = 0;
  let skipped = 0;
  let statements = 0;

  for (const [label, keep] of expected) {
    const rows = await client.run(`MATCH (n:${label}) RETURN n.id AS id`, {});
    statements++;

    const stale = rows.records
      .map((r) => Number(r.get('id')))
      .filter((id) => !keep.has(String(id)));
    if (stale.length === 0) continue;

    if (stale.length > MAX_PRUNE) {
      progress(
        `${stale.length} stale ${label} nodes — too many to remove in place. ` +
          'Run `ichor down --wipe && ichor up` for a clean graph.',
      );
      skipped += stale.length;
      continue;
    }

    progress(`removing ${stale.length} stale ${label} nodes`);
    for (const id of stale) {
      // One at a time: the subset rejects `UNWIND … DETACH DELETE`.
      await client.run(`MATCH (n:${label} {id: $id}) DETACH DELETE n`, { id: gInt(id) });
      statements++;
      removed++;
    }
  }

  return { removed, skipped, statements };
}
