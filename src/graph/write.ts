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

  // ---- wipe -------------------------------------------------------------
  // Full rebuild for now. Incremental updates land later, reusing the parse the
  // hook already performs.
  progress('clearing previous graph');
  for (const label of ['File', 'Function', 'Route', 'Model', 'Field']) {
    await client.run(`MATCH (n:${label}) DETACH DELETE n`);
    statements++;
  }

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
  // CREATE rather than MERGE: the graph was just wiped, so there is nothing to
  // deduplicate against, and CREATE avoids needing a synthetic id per edge.
  const edge = (label: string, from: string, to: string) =>
    `UNWIND $rows AS row
       MATCH (s:${from} {id: row.source_vertex}), (d:${to} {id: row.destination_vertex})
       CREATE (s)-[:${label}]->(d)`;

  progress(`writing ${facts.calls.length} CALLS edges`);
  await runBatched(
    facts.calls.map((c) => ({
      source_vertex: gInt(ids.idFor(c.fromKey)),
      destination_vertex: gInt(ids.idFor(c.toKey)),
    })),
    edge('CALLS', 'Function', 'Function'),
  );
  edgesWritten += facts.calls.length;

  progress(`writing ${facts.touches.length} TOUCHES edges`);
  await runBatched(
    facts.touches.map((t) => ({
      source_vertex: gInt(ids.idFor(t.fromKey)),
      destination_vertex: gInt(ids.idFor(t.modelKey)),
    })),
    edge('TOUCHES', 'Function', 'Model'),
  );
  edgesWritten += facts.touches.length;

  progress('writing HANDLED_BY, HAS_FIELD, DECLARES, IMPORTS edges');
  await runBatched(
    facts.routes.map((r) => ({
      source_vertex: gInt(ids.idFor(r.key)),
      destination_vertex: gInt(ids.idFor(r.handlerKey)),
    })),
    edge('HANDLED_BY', 'Route', 'Function'),
  );
  edgesWritten += facts.routes.length;

  const modelKeyByName = new Map(facts.models.map((m) => [m.name, m.key]));
  const fieldEdges = facts.fields
    .map((f) => {
      const modelKey = modelKeyByName.get(f.model);
      return modelKey
        ? { source_vertex: gInt(ids.idFor(modelKey)), destination_vertex: gInt(ids.idFor(f.key)) }
        : undefined;
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
      return fileKey
        ? { source_vertex: gInt(ids.idFor(fileKey)), destination_vertex: gInt(ids.idFor(fn.key)) }
        : undefined;
    })
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  await runBatched(declareEdges, edge('DECLARES', 'File', 'Function'));
  edgesWritten += declareEdges.length;

  await runBatched(
    facts.imports.map((i) => ({
      source_vertex: gInt(ids.idFor(i.fromFileKey)),
      destination_vertex: gInt(ids.idFor(i.toFileKey)),
    })),
    edge('IMPORTS', 'File', 'File'),
  );
  edgesWritten += facts.imports.length;

  return { nodesWritten, edgesWritten, statements, durationMs: Date.now() - started };
}
