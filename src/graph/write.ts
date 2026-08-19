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
import { IdRegistry, repoIdFor, hashId } from '../ids.js';
import type { GraphFacts } from '../extract/types.js';

/**
 * What the graph held after the last write: edge id -> the node it hangs off.
 *
 * The source key is kept, not just the id, because this engine cannot delete a
 * relationship — the only way to drop one is to delete a node it is attached to,
 * and that means knowing which node.
 */
export type EdgeLedger = Record<string, string>;

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
  /** What the graph now holds for this repo — the next run's ledger. */
  edges: EdgeLedger;
  /** Edges that are gone from the code but could not be removed. Reported, not hidden. */
  staleEdgesLeft: number;
  /**
   * Node rows dropped for sharing an id with an earlier row in the same write.
   *
   * Should always be zero. Non-zero means extraction produced two nodes for one
   * thing, which the engine would otherwise reject the whole statement over.
   */
  duplicateRowsDropped: number;
  durationMs: number;
}

export interface WriteOptions {
  /** Called with progress messages so a CLI can show what is happening. */
  onProgress?: (message: string) => void;
  /**
   * The facts from the previous run, when the caller has them.
   *
   * Pruning used to ASK THE GRAPH which nodes exist and subtract the ones we
   * still want. That is a scan of every node of every label, and on a database
   * holding four projects — about 14,000 functions — it exceeded the engine's
   * 30-second query limit and took the whole write down with it.
   *
   * We already know what we wrote last time. Diffing two local lists is exact,
   * costs nothing, and gets slower with nothing. Without it, pruning is skipped
   * and says so rather than guessing.
   */
  previous?: GraphFacts;
  /**
   * The edge ids this repo had in the graph after the previous write.
   *
   * With it, a refresh writes only what changed — usually a handful of edges
   * instead of thirteen thousand. Without it the write still works, it is just
   * the slow upsert-everything path, and it says so.
   */
  previousEdges?: EdgeLedger;
}

export async function writeGraph(
  client: GraphClient,
  facts: GraphFacts,
  options: WriteOptions = {},
): Promise<WriteStats> {
  const started = Date.now();
  const progress = options.onProgress ?? (() => {});
  const ids = new IdRegistry();

  /**
   * Which project every node belongs to.
   *
   * Repo-scoped KEYS already make two projects' nodes distinct, so ids can never
   * collide. This property is the second half of the job: it is what lets a
   * query with an UNBOUND pattern — "every Function called `handler`" — stay
   * inside one project. Keys stop collisions; this stops bleed.
   */
  const repo = repoIdFor(facts.repoRoot);

  let nodesWritten = 0;
  let duplicateRowsDropped = 0;
  let edgesWritten = 0;
  let statements = 0;
  let edges: EdgeLedger = {};
  let staleEdgesLeft = 0;
  /**
   * Nodes the edge plan will delete, and which therefore must be written back.
   *
   * Filled in before the node phases run — the plan is computed first for exactly
   * this reason.
   */
  const rebuilding = new Set<string>();

  /** Run one UNWIND per chunk. */
  const runBatched = async <T>(rows: T[], cypher: string): Promise<void> => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await client.run(cypher, { rows: rows.slice(i, i + BATCH_SIZE) });
      statements++;
    }
  };

  /**
   * Only the nodes whose content is not already in the graph.
   *
   * Upserting every node on every build is the other half of what bug 8 is. The
   * edge ledger fixed the edge side; the NODE side was still rewriting all 7,101
   * of papermark's nodes each time, and on a database holding four projects
   * `UNWIND … MERGE (n {id}) SET n:File, …` for 1,376 files **exceeded the
   * engine's 30-second ceiling on its own** — before a single edge or query.
   * Everything on this engine gets more expensive as the database fills, so the
   * only durable answer is to stop doing work that changes nothing.
   *
   * Compared by the fact itself, not by key: a function that moved to a new line
   * has the same key and different properties, and skipping it would leave the
   * graph quietly reporting the old line number.
   */
  const changed = <T extends { key: string }>(
    current: T[],
    previous: T[] | undefined,
    force: Set<string>,
  ): T[] => {
    if (!previous) return current;
    const before = new Map(previous.map((row) => [row.key, JSON.stringify(row)]));
    return current.filter(
      // `force` holds the nodes the edge plan is about to DETACH DELETE. Their
      // facts have not changed, so the diff would skip them — and they would never
      // come back, which is the "MATCH endpoint vertex … does not exist" failure
      // this file already learned once.
      (row) => force.has(row.key) || before.get(row.key) !== JSON.stringify(row),
    );
  };

  /**
   * Two rows for one node id, in one statement, kills the whole write.
   *
   * HydraDB answers a batch containing the same vertex twice with different
   * property values by rejecting the ENTIRE statement:
   *
   *   conflicting metadata values for vertex 2802411236362412 property line
   *
   * Not the row — the statement, and with it the build. A single duplicate key
   * anywhere in a repository therefore made that repository impossible to index,
   * with an error naming a number and nothing a reader could act on. That is what
   * happened to a real 1,396-file project: one merged interface out of 8,098
   * distinct ids, and no graph at all.
   *
   * The extractor is where that particular duplicate was fixed. This is here
   * because the extractor is not the only thing that could ever produce one, and
   * the cost of being wrong is catastrophically out of proportion to the cause.
   * The first row wins, the rest are counted and named (rule 2) — so an unknown
   * future duplicate costs one reported line instead of the whole product.
   */
  const dedupeByVertex = (
    rows: Record<string, unknown>[],
    label: string,
  ): Record<string, unknown>[] => {
    const seen = new Set<string>();
    const kept: Record<string, unknown>[] = [];
    let dropped = 0;

    for (const row of rows) {
      const id = String(row.vertex);
      if (seen.has(id)) {
        dropped++;
        continue;
      }
      seen.add(id);
      kept.push(row);
    }

    if (dropped > 0) {
      duplicateRowsDropped += dropped;
      progress(
        `⚠ ${dropped} duplicate ${label} row${dropped === 1 ? '' : 's'} share a node id with an ` +
          `earlier row — kept the first of each. This is a bug in extraction, not in your code.`,
      );
    }
    return kept;
  };

  /** Say what was skipped, so a fast build is never mistaken for a broken one. */
  const nodePhase = async <T extends { key: string }>(
    label: string,
    current: T[],
    previous: T[] | undefined,
    rows: (subset: T[]) => Record<string, unknown>[],
    cypher: string,
  ): Promise<void> => {
    const todo = changed(current, previous, rebuilding);
    progress(
      todo.length === current.length
        ? `writing ${current.length} ${label}`
        : `writing ${todo.length} changed ${label} (${current.length - todo.length} unchanged, skipped)`,
    );
    const batch = dedupeByVertex(rows(todo), label);
    await runBatched(batch, cypher);
    nodesWritten += batch.length;
  };


  /**
   * One stable id per relationship, so the same edge is never written twice.
   *
   * `fromKey`/`toKey` ride along unused by the queries. They are what lets the
   * delta below work out which edges touch a node it had to delete, so those can
   * be put back — see `writeEdges`.
   */
  const edgeRow = (label: string, fromKey: string, toKey: string) => ({
    source_vertex: gInt(ids.idFor(fromKey)),
    destination_vertex: gInt(ids.idFor(toKey)),
    edge_id: gInt(ids.idFor(`edge:${label}:${fromKey}->${toKey}`)),
    fromKey,
    toKey,
  });

  /**
   * Every edge group, built before anything is written.
   *
   * Collected rather than written straight out because the decision of HOW to
   * write — create the few that changed, or upsert all thirteen thousand — can
   * only be made once the whole set is known.
   */
  const groups: EdgeGroupRows[] = [];

  // `render` distinguishes `<Child />` from `child()`. Both are real edges and
  // both belong on CALLS — the alternative, a separate RENDERS relationship, is
  // not available here: this engine rejects `-[:CALLS|RENDERS]->`, so every query
  // that legitimately wants both directions of dependency could never rejoin them.
  //
  // It is written on EVERY row, never left absent, because `WHERE NOT c.render`
  // is also unsupported — `{render: false}` is the only way to ask for real calls,
  // and that matches nothing on rows where the property was omitted.
  groups.push({
    label: 'CALLS',
    from: 'Function',
    to: 'Function',
    rows: facts.calls.map((c) => ({
      ...edgeRow('CALLS', c.fromKey, c.toKey),
      render: c.viaRender === true,
      contains: c.viaContains === true,
    })),
    props: ['render', 'contains'],
  });

  groups.push({
    label: 'TOUCHES',
    from: 'Function',
    to: 'Model',
    rows: facts.touches.map((t) => edgeRow('TOUCHES', t.fromKey, t.modelKey)),
  });

  groups.push({
    label: 'HANDLED_BY',
    from: 'Route',
    to: 'Function',
    rows: facts.routes.map((r) => edgeRow('HANDLED_BY', r.key, r.handlerKey)),
  });

  const modelKeyByName = new Map(facts.models.map((m) => [m.name, m.key]));
  groups.push({
    label: 'HAS_FIELD',
    from: 'Model',
    to: 'Field',
    rows: facts.fields
      .map((f) => {
        const modelKey = modelKeyByName.get(f.model);
        return modelKey ? edgeRow('HAS_FIELD', modelKey, f.key) : undefined;
      })
      .filter((r): r is NonNullable<typeof r> => r !== undefined),
  });

  // A file DECLARES the functions and types defined in it — this is what lets us
  // ask "what else lives in this file", which matters when an agent edits a
  // neighbouring symbol.
  const fileKeyByPath = new Map(facts.files.map((f) => [f.path, f.key]));
  const declaredBy = (items: { file: string; key: string }[]) =>
    items
      .map((item) => {
        const fileKey = fileKeyByPath.get(item.file);
        return fileKey ? edgeRow('DECLARES', fileKey, item.key) : undefined;
      })
      .filter((r): r is NonNullable<typeof r> => r !== undefined);

  groups.push({ label: 'DECLARES', from: 'File', to: 'Function', rows: declaredBy(facts.functions) });
  groups.push({ label: 'DECLARES', from: 'File', to: 'Type', rows: declaredBy(facts.types) });
  // A Prisma schema declares its models the same way. This is what lets an edit
  // to `prisma/schema/link.prisma` be read as a change to `Link` rather than as
  // an unexplained edit to a file nothing in the graph mentions.
  groups.push({ label: 'DECLARES', from: 'File', to: 'Model', rows: declaredBy(facts.models) });

  groups.push({
    label: 'IMPORTS',
    from: 'File',
    to: 'File',
    rows: facts.imports.map((i) => edgeRow('IMPORTS', i.fromFileKey, i.toFileKey)),
  });

  // Split by what the reference starts FROM. A type mention inside a function
  // body is `Function -> Type`; one inside an interface body — `interface Order
  // { vendor: Vendor }` — is `Type -> Type`, and is just as real. HydraDB checks
  // the label on both ends, so sending them down one query rejects the whole
  // batch with "endpoint vertex does not have label Function".
  const typeKeys = new Set(facts.types.map((t) => t.key));
  groups.push({
    label: 'REFERENCES',
    from: 'Function',
    to: 'Type',
    rows: facts.references
      .filter((r) => !typeKeys.has(r.fromKey))
      .map((r) => edgeRow('REFERENCES', r.fromKey, r.toKey)),
  });
  groups.push({
    label: 'REFERENCES',
    from: 'Type',
    to: 'Type',
    rows: facts.references
      .filter((r) => typeKeys.has(r.fromKey))
      .map((r) => edgeRow('REFERENCES', r.fromKey, r.toKey)),
  });


  // ---- decide what actually has to be written ---------------------------
  //
  // Planned BEFORE the nodes are written, because a stale edge can only be
  // removed by deleting a node it hangs off — and that node then has to be
  // re-created. Doing the delete after the node phase left the graph missing
  // the very endpoints the edge writes then matched on:
  //   "MATCH endpoint vertex … with label File does not exist"
  /**
   * Is this repo in the graph at all?
   *
   * Asked EVERY time, not only when there is no ledger. The local record and the
   * database can disagree — `ichor down --wipe` leaves `.ichor/` untouched — and a
   * ledger describing a graph that no longer exists would make the delta skip
   * everything and leave the repo with no graph at all, silently. One bounded
   * count, with the filter in the pattern rather than a `WHERE`, which is how two
   * separate 30-second timeouts happened here before.
   */
  // Up to five of this repo's own files, by id. See isRepoEmpty for why not `repo`.
  const probeKeys = facts.files.slice(0, 5).map((f) => f.key);
  const repoIsEmpty =
    probeKeys.length === 0 || (await isRepoEmpty(client, ids, 'File', probeKeys, progress));
  statements += probeKeys.length;

  if (repoIsEmpty && options.previousEdges) {
    progress('the graph no longer holds this repo — ignoring the local record and writing it all');
  }
  // An empty graph makes both records worthless, so neither is trusted.
  const previousEdges = repoIsEmpty ? undefined : options.previousEdges;
  const previousFacts = repoIsEmpty ? undefined : options.previous;

  const plan = planEdges(groups, previousEdges, repoIsEmpty);
  edges = plan.ledger;
  staleEdgesLeft = plan.staleLeft;

  for (const key of plan.rebuild) rebuilding.add(key);

  if (plan.rebuild.length > 0) {
    progress(`rebuilding ${plan.rebuild.length} nodes that lost an edge`);
    for (const key of plan.rebuild) {
      await client.run('MATCH (n {id: $id}) DETACH DELETE n', { id: gInt(ids.idFor(key)) });
      statements++;
    }
  }

  // ---- nodes ------------------------------------------------------------
  //
  // Only what changed. See `nodePhase`: rewriting every node on every build is the
  // node half of bug 8, and on a database holding four projects the files alone
  // exceeded the engine's 30-second ceiling.
  const was = previousFacts;

  await nodePhase(
    'files',
    facts.files,
    was?.files,
    (rows) => rows.map((f) => ({ vertex: gInt(ids.idFor(f.key)), path: f.path, repo })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:File, n.path = row.path, n.repo = row.repo`,
  );

  await nodePhase(
    'functions',
    facts.functions,
    was?.functions,
    (rows) =>
      rows.map((fn) => ({
        vertex: gInt(ids.idFor(fn.key)),
        repo,
        name: fn.name,
        file: fn.file,
        line: gInt(fn.line),
        exported: fn.exported,
        isComponent: fn.isComponent,
        isTest: fn.isTest,
        // The outermost declaration this function lives in — `VendorForm` for
        // `VendorForm.handleSubmit`, and its own name for a top-level function.
        //
        // This is what "how many places use this" has to be counted over. A
        // component with three handlers that each mention a type is ONE place
        // using it, not three, and counting the nodes instead made `LinkWithViews`
        // look like a 43-user shared shape rather than the 22-user subject it is —
        // which got it discarded as furniture, leaving a task with no boundary
        // at all and therefore every edit challenged.
        root: `${fn.file}#${fn.name.split('.')[0]}`,
      })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex})
       SET n:Function, n.name = row.name, n.file = row.file, n.line = row.line,
           n.exported = row.exported, n.isComponent = row.isComponent,
           n.isTest = row.isTest, n.root = row.root, n.repo = row.repo`,
  );

  await nodePhase(
    'types',
    facts.types,
    was?.types,
    (rows) =>
      rows.map((t) => ({
        vertex: gInt(ids.idFor(t.key)),
        repo,
        name: t.name,
        file: t.file,
        line: t.line,
        kind: t.kind,
        exported: t.exported,
      })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex})
       SET n:Type, n.repo = row.repo, n.name = row.name, n.file = row.file, n.line = row.line,
           n.kind = row.kind, n.exported = row.exported`,
  );

  await nodePhase(
    'routes',
    facts.routes,
    was?.routes,
    (rows) =>
      rows.map((r) => ({
        vertex: gInt(ids.idFor(r.key)),
        repo,
        method: r.method,
        path: r.path,
        file: r.file,
        line: gInt(r.line),
      })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex})
       SET n:Route, n.repo = row.repo, n.method = row.method, n.path = row.path, n.file = row.file, n.line = row.line`,
  );

  await nodePhase(
    'models',
    facts.models,
    was?.models,
    (rows) => rows.map((m) => ({ vertex: gInt(ids.idFor(m.key)), name: m.name, repo })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Model, n.name = row.name, n.repo = row.repo`,
  );

  await nodePhase(
    'fields',
    facts.fields,
    was?.fields,
    (rows) =>
      rows.map((f) => ({
        vertex: gInt(ids.idFor(f.key)),
        repo,
        name: f.name,
        model: f.model,
        type: f.type,
        isUnique: f.isUnique,
        isId: f.isId,
      })),
    `UNWIND $rows AS row MERGE (n {id: row.vertex})
       SET n:Field, n.repo = row.repo, n.name = row.name, n.model = row.model, n.type = row.type,
           n.isUnique = row.isUnique, n.isId = row.isId`,
  );

  // ---- edges -------------------------------------------------------------
  const edgeResult = await writeEdges(client, plan, {
    progress,
    runOne: async (cypher, params) => {
      await client.run(cypher, params);
      statements++;
    },
  });
  edgesWritten += edgeResult.created;

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

  const pruned = await prune(client, facts, previousFacts, progress);
  statements += pruned.statements;

  return {
    nodesWritten,
    duplicateRowsDropped,
    edgesWritten,
    statements,
    nodesPruned: pruned.removed,
    stalePruneSkipped: pruned.skipped,
    edges,
    staleEdgesLeft,
    durationMs: Date.now() - started,
  };
}

interface EdgePlan {
  ledger: EdgeLedger;
  /** Only the groups and rows that actually have to be written. */
  write: EdgeGroupRows[];
  /**
   * `CREATE` instead of `MERGE`, because nothing is there to collide with.
   *
   * Only ever set when the graph was measured empty for this repo. MERGE has to
   * scan an endpoint's existing relationships before deciding; CREATE does not,
   * and on a first index that is the difference between seconds and a timeout.
   */
  create: boolean;
  /** Nodes to delete and re-create, because they lost an edge. */
  rebuild: string[];
  /** Edges gone from the code that will still be in the graph afterwards. */
  staleLeft: number;
  /** Total edges this repo should have, for reporting. */
  total: number;
}

interface EdgeGroupRows {
  label: string;
  from: string;
  to: string;
  rows: { edge_id: unknown; fromKey: string; toKey: string; [k: string]: unknown }[];
  /**
   * Extra properties this edge type carries, by name.
   *
   * Names rather than a Cypher fragment, because the two write forms need
   * DIFFERENT syntax for the same thing and this engine accepts each in only one
   * place:
   *
   *   MERGE (a)-[e:L {id}]->(b) SET e.x = row.x     the pattern is the identity
   *                                                 matched on, so x cannot be in it
   *   CREATE (a)-[:L {id, x: row.x}]->(b)           "CREATE with following clauses
   *                                                 is not executable" — no SET
   *
   * Holding the names once and building both forms from them keeps a single
   * owner for what an edge carries.
   */
  props?: string[];
}

/**
 * One row per relationship.
 *
 * The extracted facts are per SITE, not per edge: papermark has 9,790 call sites
 * across 7,331 distinct caller→callee pairs, all sharing a derived edge id. MERGE
 * hid this by collapsing them on write; CREATE does not, and writing them
 * unchanged produced 9,790 relationships where 7,331 belong — every path Ichor
 * cites through one of them counted twice.
 *
 * Where duplicates disagree on a qualifier, the STRONGEST claim wins: `render`
 * and `contains` both mean "not a plain call", so a pair with any direct call
 * between them is a direct call. Reducing with AND is what makes that true, and
 * it also makes the result independent of the order the sites were found in —
 * MERGE + SET let the last row silently win.
 */
function dedupe(group: EdgeGroupRows): EdgeGroupRows {
  const byId = new Map<string, EdgeGroupRows['rows'][number]>();
  for (const row of group.rows) {
    const id = String(row.edge_id);
    const seen = byId.get(id);
    if (!seen) {
      byId.set(id, row);
      continue;
    }
    for (const prop of group.props ?? []) {
      seen[prop] = Boolean(seen[prop]) && Boolean(row[prop]);
    }
  }
  return byId.size === group.rows.length ? group : { ...group, rows: [...byId.values()] };
}

/**
 * Work out the smallest correct set of edge writes. Pure — touches nothing.
 *
 * WHY THIS EXISTS
 *
 * Upserting every edge on every build is what made `ichor start` fail on a real
 * repository. Measured: 9,790 CALLS edges write in 150ms, but 1,198 TOUCHES took
 * 16.1 SECONDS and 2,414 REFERENCES took 23.2 — past the engine's 30-second
 * statement ceiling, so the command died.
 *
 * It is not the shape of those queries. On a fresh database the same writes take
 * 94ms and 1.9s; they get dramatically more expensive as the graph fills, and no
 * rewrite of the Cypher changed that. So the fix is not a faster write — it is
 * not writing thirteen thousand edges to record that ten changed.
 *
 * WHAT THIS ENGINE ALLOWS, MEASURED
 *
 *   CREATE / MERGE a relationship    yes; MERGE cost grows with the graph
 *   DELETE or SET a MATCHED one      NO — "unbound variable e", in every form
 *   DETACH DELETE a node             yes, ~134ms each
 *
 * A relationship therefore cannot be removed on its own. The only way to drop one
 * is to delete a node it hangs off — which also drops that node's OTHER edges, so
 * everything still attached has to be written back. That is what `rebuild` is,
 * and why the caller must delete BEFORE writing nodes.
 */
function planEdges(
  groups: EdgeGroupRows[],
  previous: EdgeLedger | undefined,
  /** Measured, never assumed: does this repo have any nodes in the graph yet? */
  repoIsEmpty: boolean,
): EdgePlan {
  const idOf = (row: { edge_id: unknown }) => String(row.edge_id);

  groups = groups.map(dedupe);

  const ledger: EdgeLedger = {};
  for (const g of groups) for (const row of g.rows) ledger[idOf(row)] = row.fromKey;
  const total = Object.keys(ledger).length;

  // No record of the last write. Everything has to be written, and the only
  // question is whether it is safe to CREATE. It is exactly when the graph holds
  // nothing for this repo — otherwise creating an edge that is already there
  // would double every path Ichor later cites.
  if (!previous) {
    return { ledger, write: groups, create: repoIsEmpty, rebuild: [], staleLeft: 0, total };
  }

  const before = new Set(Object.keys(previous));
  const gone = Object.keys(previous).filter((id) => !(id in ledger));

  // Only the SOURCE of a stale edge is rebuilt. Its destination is usually
  // something shared — a Model, a widely-used Type — and deleting that would
  // take every other edge pointing at it down too.
  const lost = [...new Set(gone.map((id) => previous[id]).filter(Boolean))];

  // More rebuilding than a turn between prompts can account for — usually a
  // branch switch or a big generated diff. At ~134ms a node this would blow the
  // 30-second ceiling and take the whole write down.
  //
  // The stale edges are then left in place and REPORTED. That is not a lesser
  // version of the fix: upserting the full set would not have removed them
  // either — MERGE only adds — so the expensive path buys nothing here. The new
  // edges still get written, so the graph is complete; it is over-complete, and
  // says so (rule 2).
  const overCap = lost.length > MAX_REBUILD;
  const rebuilding = new Set(overCap ? [] : lost);

  const write = groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter(
        // New, or attached to a node about to be deleted and re-created.
        (row) => !before.has(idOf(row)) || rebuilding.has(row.fromKey) || rebuilding.has(row.toKey),
      ),
    }))
    .filter((g) => g.rows.length > 0);

  return {
    ledger,
    write,
    // A ledger means edges are already there, so this is never a clean CREATE —
    // except on a repo whose graph has been wiped underneath us, and MERGE is
    // correct there too, just slower.
    create: false,
    rebuild: overCap ? [] : lost,
    staleLeft: overCap ? gone.length : 0,
    total,
  };
}

/**
 * Does the graph hold anything for this repo?
 *
 * `count(*)`, never `count(f)` — this engine rejects an aggregate over a named
 * variable, and reports it as "property values support integer, float, boolean,
 * and string literals", which points at the pattern rather than the count. That
 * misreading cost a debugging pass here.
 *
 * Fails CLOSED: an unreadable count means "not empty", so the write takes the
 * safe MERGE path. Guessing "empty" and being wrong would duplicate every
 * relationship in the repository. It says so rather than deciding in silence.
 */
async function isRepoEmpty(
  client: GraphClient,
  ids: IdRegistry,
  label: string,
  probeKeys: string[],
  progress: (message: string) => void,
): Promise<boolean> {
  try {
    /**
     * THE LABEL IS NOT DECORATION. Without it this function always said "no".
     *
     * The probe used to be `MATCH (n {id: $id}) RETURN n.id AS id LIMIT 1`, and on
     * this engine an unlabelled node pattern carrying an id does not MATCH — it
     * echoes the id straight back. Measured: ids 123 and 999999999999, neither of
     * which can exist, each returned exactly one record containing themselves.
     *
     * So this function returned false on every call ever made, and the guard it
     * exists to provide — noticing that the graph no longer holds this repo —
     * never fired once. `MATCH (n:File {id: $id})` answers correctly: a real id
     * returns one record in 33ms, an impossible one returns none in 2ms.
     *
     * How it surfaced: `ichor down --wipe` in one repo, `ichor start` in another,
     * and then a `delta:test` reporting **0 edges in the graph against a local
     * ledger claiming 21,384** — the exact scenario the comment below predicted,
     * happening anyway because the code meant to prevent it was inert.
     *
     * The third variant of one mistake in this file. `count(f)` is misreported as
     * a property-value error; a property filter in a `WHERE` silently becomes a
     * scan; and an unlabelled id pattern silently becomes an echo. Every one of
     * them returns something that looks like an answer.
     *
     * Looked up by ID, never by `{repo: …}`.
     *
     * This engine has no property indexes — `CREATE INDEX` in every form is
     * rejected — so a repo-scoped match SCANS. Measured on a database holding five
     * projects: `MATCH (f:File {repo: $repo}) … LIMIT 1` took **146 seconds**,
     * while a lookup by id took **47ms** and did not care how full the database
     * was. `LIMIT 1` does not save a scan when there is nothing to seek on.
     *
     * A handful of ids rather than one, because the single file we happened to ask
     * about may have been pruned since. Any hit means the repo is present.
     */
    for (const key of probeKeys) {
      const result = await client.run(`MATCH (n:${label} {id: $id}) RETURN n.id AS id LIMIT 1`, {
        id: gInt(ids.idFor(key)),
      });
      if (result.records.length > 0) return false;
    }
    return true;
  } catch (error) {
    progress(
      `could not tell whether this repo is already in the graph (${(error as Error).message.split('\n')[0]}) ` +
        '— taking the slower, always-correct path',
    );
    return false;
  }
}

/** Execute a plan. */
async function writeEdges(
  client: GraphClient,
  plan: EdgePlan,
  deps: {
    progress: (message: string) => void;
    runOne: (cypher: string, params: Record<string, unknown>) => Promise<void>;
  },
): Promise<{ created: number }> {
  const { progress, runOne } = deps;
  const created = plan.write.reduce((n, g) => n + g.rows.length, 0);

  if (created === 0) {
    progress(`no edges changed (${plan.total} already correct)`);
    return { created: 0 };
  }
  if (created < plan.total) {
    progress(`writing ${created} changed edges (${plan.total - created} unchanged, skipped)`);
  } else if (plan.create) {
    progress(`writing ${created} edges`);
  } else {
    // Said out loud rather than endured in silence. This is the path that made
    // `ichor start` exceed the engine's statement ceiling on a real repository,
    // and it is taken only when the graph already holds this repo and the local
    // record of what we wrote is gone.
    progress(
      `writing all ${created} edges the slow way — no record of the last write, ` +
        'so every edge has to be checked before it is added',
    );
  }

  for (const g of plan.write) {
    // MERGE unless the graph was measured empty: a rebuilt node's edges may
    // already exist elsewhere in the batch, and a duplicate relationship would
    // double a cited path.
    //
    // Each form carries its extra properties where this engine allows it — in
    // the pattern for CREATE, in a trailing SET for MERGE. See `props`.
    const extra = g.props ?? [];
    const write = plan.create
      ? `CREATE (s)-[:${g.label} {id: row.edge_id` +
        extra.map((p) => `, ${p}: row.${p}`).join('') +
        `}]->(d)`
      : `MERGE (s)-[e:${g.label} {id: row.edge_id}]->(d)` +
        (extra.length ? `\n       SET ${extra.map((p) => `e.${p} = row.${p}`).join(', ')}` : '');

    const cypher =
      `UNWIND $rows AS row\n` +
      `       MATCH (s:${g.from} {id: row.source_vertex}), (d:${g.to} {id: row.destination_vertex})\n` +
      `       ${write}`;

    for (let i = 0; i < g.rows.length; i += BATCH_SIZE) {
      await runOne(cypher, { rows: g.rows.slice(i, i + BATCH_SIZE) });
    }
  }

  if (plan.staleLeft > 0) {
    progress(
      `⚠ ${plan.staleLeft} edges are gone from the code but still in the graph — ` +
        'too many nodes to rebuild in place. `ichor down --wipe && ichor up` for a clean graph.',
    );
  }
  return { created };
}

/** How many stale nodes we are willing to remove before saying it is too many. */
const MAX_PRUNE = 150;

/**
 * How many nodes we will delete-and-recreate to drop their stale edges.
 *
 * At ~134ms a node that is about eight seconds, and each one also has its
 * surviving edges written back. A turn between two prompts touches a handful of
 * functions; anything past this is a different kind of event — a branch switch,
 * a generated diff — and is reported instead of attempted.
 */
const MAX_REBUILD = 60;

/**
 * Register this repository in the graph.
 *
 * This used to REFUSE a second repository outright, because nodes were keyed by
 * repo-RELATIVE path: two projects each containing a `src/lib/db.ts` collided
 * onto one node, and `model:User` collided across any two projects at all. A
 * graph that answers confidently about a mixture of two codebases is a wrong
 * answer, which is worse than a crash — so the refusal was right at the time.
 *
 * Keys now carry the repository (see ids.ts), so the collision cannot happen and
 * projects simply coexist. One marker per repo, and its id is derived from the
 * repo rather than fixed, so two markers never overwrite each other.
 */
async function claimGraph(client: GraphClient, repoRoot: string): Promise<void> {
  const normalised = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const repo = repoIdFor(repoRoot);

  // Wrapped in UNWIND because a bare `MERGE … SET` is rejected — "MERGE with
  // following clauses is not executable" — while the same pair inside an UNWIND
  // is fine, which is how every node in this file is written.
  await client.run(
    'UNWIND $rows AS row MERGE (m {id: row.vertex}) SET m:IchorGraph, m.repoRoot = row.repoRoot, m.repo = row.repo',
    {
      rows: [{ vertex: gInt(hashId(`ichor:graph:${repo}`)), repoRoot: normalised, repo }],
    },
  );
}

async function prune(
  client: GraphClient,
  facts: GraphFacts,
  previous: GraphFacts | undefined,
  progress: (message: string) => void,
): Promise<{ removed: number; skipped: number; statements: number }> {
  // Nothing to compare against: a first build has nothing stale by definition,
  // and a caller that did not keep the previous facts gets told rather than
  // charged for a scan that may not finish.
  if (!previous) return { removed: 0, skipped: 0, statements: 0 };

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

  // Scoped to this repository. Without the filter, watching a second project
  // would see every node of the first as "stale" and try to delete the lot.
  const repo = repoIdFor(facts.repoRoot);

  // What the PREVIOUS run wrote, by label. Stale is simply what it had and this
  // run does not — no query, exact, and it does not get slower as more projects
  // share the database.
  const before = new Map<string, string[]>([
    ['File', previous.files.map((f) => String(ids.idFor(f.key)))],
    ['Function', previous.functions.map((f) => String(ids.idFor(f.key)))],
    ['Route', previous.routes.map((r) => String(ids.idFor(r.key)))],
    ['Model', previous.models.map((m) => String(ids.idFor(m.key)))],
    ['Field', previous.fields.map((f) => String(ids.idFor(f.key)))],
    ['Type', previous.types.map((t) => String(ids.idFor(t.key)))],
  ]);

  for (const [label, keep] of expected) {
    const stale = (before.get(label) ?? [])
      .filter((id) => !keep.has(id))
      .map((id) => Number(id));
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
