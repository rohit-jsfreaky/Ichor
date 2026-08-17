/**
 * Structural questions an agent can ask the graph.
 *
 * Ichor's other queries exist to police an edit. These exist to be USEFUL: an
 * agent that wants to know what calls a function currently greps for the name
 * and opens every file that matches. A real Codex run searched the repo for
 * five words, got 116 hits, and read six whole files — to answer a question the
 * graph answers in milliseconds and had already answered before the agent
 * started.
 *
 * Two rules shape everything here:
 *
 *   Rule 2 — never truncate silently. Every function below over-fetches by one
 *   row so it can tell the difference between "that is all of them" and "that is
 *   as many as you asked for", and says which.
 *
 *   Rule 4 — HydraDB is a Cypher subset. `algo.SPpaths` is rejected on this
 *   build ("query transport cannot authorize an unsupported Cypher clause"), so
 *   whole paths with every intermediate hop are not available over Bolt. These
 *   return path SUMMARIES — entry point, handler, the function that reaches the
 *   data, and the data — and say so rather than implying completeness.
 */

import { GraphClient, gInt } from './client.js';

/** Deep enough for a real call chain, bounded because unbounded `*` is rejected. */
const MAX_DEPTH = 4;

export interface Truncatable {
  truncated: boolean;
  limit: number;
}

export interface CallerRow {
  name: string;
  file: string;
  /** 'direct' when it calls the symbol itself, 'indirect' through a chain. */
  via: 'direct' | 'indirect';
}

export interface CallersResult extends Truncatable {
  symbol: string;
  callers: CallerRow[];
  routes: { method: string; path: string; handler: string }[];
}

/**
 * Everything that reaches a function, and the endpoints that reach it.
 *
 * Two queries rather than one: HydraDB allows a single relationship type per
 * pattern, so `CALLS` and `HANDLED_BY` cannot be traversed together.
 */
export async function callersOf(
  client: GraphClient,
  symbol: string,
  repo: string,
  limit = 40,
  /**
   * The ids to start from, when the caller could work them out without asking.
   *
   * WHY THIS EXISTS
   *
   * Everything below walks by node ID, and an id lookup costs the same whatever else
   * is in the database. The one exception was finding the STARTING node, which
   * matched on name and repo — and this engine has no property indexes, so that is a
   * scan of every Function node in the whole database, other projects included.
   *
   * Rohit put the objection plainly: Ichor should query its own project's data, not
   * pay for everyone else's. He is right, and the fix costs nothing, because the
   * answer is already on disk. `facts.json` holds every function with its key, and
   * ids are derived from keys deterministically — so the starting id can be computed
   * locally and looked up directly, with no search at all.
   *
   * Measured: 32ms scanning versus 7ms by id, on a small database. The gap grows with
   * the database; the id lookup does not.
   *
   * Honest about the size of the win: the seed was about 8% of the call. The rest is
   * the walk below, one round trip per node, which this engine forces — it rejects
   * `UNWIND … MATCH` batching and `WHERE id IN $ids` alike. What this changes is that
   * the cost no longer depends on what else is loaded.
   */
  seedIds?: number[],
): Promise<CallersResult> {
  // Walked one hop at a time, deliberately.
  //
  // The obvious query — `MATCH (c:Function)-[:CALLS*1..4]->(t:Function) WHERE
  // t.name = $name` — is rejected: "variable-length MATCH requires a fixed
  // source id". A variable-length segment cannot start from an unbound node,
  // and here the node we know is the TARGET, not the source. So we pin ids and
  // widen a level at a time, which is the same shape buildNeighborhood uses.
  const resolveSeeds = async (): Promise<number[]> => {
    if (seedIds?.length) return seedIds;
    const found = await client.run(
      // The fallback, for a caller with no local facts to resolve from.
      //
      // Scoped to one project. Seeding by BARE NAME across the whole database is
      // the most dangerous pattern in this file: with two projects loaded, asking
      // who calls `handler` would answer from both, and the answer would look
      // perfectly plausible.
      `MATCH (f:Function {repo: $repo}) WHERE f.name = $name RETURN f.id AS id LIMIT 10`,
      { name: symbol, repo },
    );
    return found.records.map((r) => Number(r.get('id')));
  };

  const seen = new Set<string>();
  const callers: CallerRow[] = [];
  // Ids come back as Bolt integers and must go back out through gInt(): a plain
  // JS number is encoded as a FLOAT and rejected with "node id property must be
  // an integer".
  let frontier = await resolveSeeds();
  let truncated = false;

  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: number[] = [];

    for (const id of frontier) {
      const rows = await client.run(
        `MATCH (caller:Function)-[:CALLS]->(target:Function {id: $id})
           RETURN caller.id AS id, caller.name AS name, caller.file AS file
           LIMIT ${limit + 1}`,
        { id: gInt(id) },
      );
      if (rows.records.length > limit) truncated = true;

      for (const record of rows.records.slice(0, limit)) {
        const name = String(record.get('name'));
        const file = String(record.get('file'));
        const key = `${name}#${file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        callers.push({ name, file, via: depth === 1 ? 'direct' : 'indirect' });
        next.push(Number(record.get('id')));
      }
    }

    frontier = next;
    if (callers.length >= limit) {
      truncated = truncated || frontier.length > 0;
      break;
    }
  }

  const routes = await client.run(
    `MATCH (r:Route {repo: $repo})-[:HANDLED_BY]->(h:Function)
       WHERE h.name = $name
       RETURN r.method AS method, r.path AS path, h.name AS handler
       LIMIT ${limit + 1}`,
    { name: symbol, repo },
  );

  return {
    symbol,
    callers,
    routes: routes.records.slice(0, limit).map((r) => ({
      method: String(r.get('method')),
      path: String(r.get('path')),
      handler: String(r.get('handler')),
    })),
    truncated: truncated || routes.records.length > limit,
    limit,
  };
}

export interface PathSummary {
  method: string;
  route: string;
  handler: string;
  reacher: string;
  model: string;
}

export interface PathsResult extends Truncatable {
  model: string;
  paths: PathSummary[];
}

/**
 * How the application reaches a table.
 *
 * The question no file search can answer: which HTTP entry points can end up
 * touching this data, and through which function.
 */
export async function pathsToModel(
  client: GraphClient,
  model: string,
  repo: string,
  options: { route?: string; limit?: number } = {},
): Promise<PathsResult> {
  const limit = options.limit ?? 40;

  const rows = await client.run(
    // Pinning the route to one project pins the whole path: an edge never joins
    // two projects, so every node downstream of a scoped start is scoped too.
    `MATCH (r:Route {repo: $repo})-[:HANDLED_BY]->(h:Function)-[:CALLS*1..${MAX_DEPTH}]->(f:Function)-[:TOUCHES]->(m:Model)
       WHERE m.name = $model
       RETURN r.method AS method, r.path AS path, h.name AS handler, f.name AS reacher
       LIMIT ${limit + 1}`,
    { model, repo },
  );

  // Filtering by route happens here, not in the query: HydraDB rejects
  // `CONTAINS` in a WHERE clause (rule 4).
  const all = rows.records.slice(0, limit).map((record) => ({
    method: String(record.get('method')),
    route: String(record.get('path')),
    handler: String(record.get('handler')),
    reacher: String(record.get('reacher')),
    model,
  }));

  const paths = options.route
    ? all.filter((p) => p.route.toLowerCase().includes(options.route!.toLowerCase()))
    : all;

  return { model, paths, truncated: rows.records.length > limit, limit };
}

/** Handlers that reach a model directly, for the case where no route is involved. */
export async function functionsTouching(
  client: GraphClient,
  model: string,
  repo: string,
  limit = 40,
): Promise<{ functions: { name: string; file: string }[] } & Truncatable> {
  const rows = await client.run(
    `MATCH (f:Function {repo: $repo})-[:TOUCHES]->(m:Model)
       WHERE m.name = $model
       RETURN f.name AS name, f.file AS file
       LIMIT ${limit + 1}`,
    { model, repo },
  );

  return {
    functions: rows.records.slice(0, limit).map((r) => ({
      name: String(r.get('name')),
      file: String(r.get('file')),
    })),
    truncated: rows.records.length > limit,
    limit,
  };
}

/**
 * What else is affected if this symbol changes.
 *
 * The question an agent should ask before editing anything and usually cannot,
 * because a text search finds the name in comments, in strings, and in three
 * unrelated files that happen to use the same word. This is the compiled answer:
 * who calls it, which endpoints end up running it, which tables are at stake,
 * and — for a type — who depends on its shape.
 */
export interface ImpactResult extends Truncatable {
  symbol: string;
  kind: 'function' | 'type' | 'both' | 'unknown';
  /** Where the symbol itself is declared. */
  declaredIn: string[];
  callers: CallerRow[];
  routes: { method: string; path: string }[];
  /** Functions whose signature or body mentions this TYPE. */
  referencedBy: { name: string; file: string }[];
  /** Tables this function reads or writes — what the blast radius touches. */
  models: string[];
}

export async function impactOf(
  client: GraphClient,
  symbol: string,
  repo: string,
  limit = 40,
  /** Passed straight through — see `callersOf`. */
  seedIds?: number[],
): Promise<ImpactResult> {
  // Reuse the caller walk rather than repeat it: it already handles the chain,
  // the endpoints behind it, and reporting truncation honestly.
  const reach = await callersOf(client, symbol, repo, limit, seedIds);

  const functionRows = await client.run(
    `MATCH (f:Function {repo: $repo}) WHERE f.name = $name RETURN f.file AS file LIMIT 10`,
    { name: symbol, repo },
  );
  const typeRows = await client.run(
    `MATCH (t:Type {repo: $repo}) WHERE t.name = $name RETURN t.file AS file LIMIT 10`,
    { name: symbol, repo },
  );

  const isFunction = functionRows.records.length > 0;
  const isType = typeRows.records.length > 0;

  const referenced = isType
    ? await client.run(
        `MATCH (f:Function {repo: $repo})-[:REFERENCES]->(t:Type)
           WHERE t.name = $name
           RETURN f.name AS name, f.file AS file
           LIMIT ${limit + 1}`,
        { name: symbol, repo },
      )
    : { records: [] as { get(key: string): unknown }[] };

  const touched = isFunction
    ? await client.run(
        `MATCH (f:Function {repo: $repo})-[:TOUCHES]->(m:Model)
           WHERE f.name = $name
           RETURN m.name AS name LIMIT 20`,
        { name: symbol, repo },
      )
    : { records: [] as { get(key: string): unknown }[] };

  return {
    symbol,
    kind: isFunction && isType ? 'both' : isFunction ? 'function' : isType ? 'type' : 'unknown',
    declaredIn: [
      ...new Set([
        ...functionRows.records.map((r) => String(r.get('file'))),
        ...typeRows.records.map((r) => String(r.get('file'))),
      ]),
    ],
    callers: reach.callers,
    routes: reach.routes,
    referencedBy: referenced.records.slice(0, limit).map((r) => ({
      name: String(r.get('name')),
      file: String(r.get('file')),
    })),
    models: [...new Set(touched.records.map((r) => String(r.get('name'))))],
    truncated: reach.truncated || referenced.records.length > limit,
    limit,
  };
}
