/**
 * Grow anchors into a task neighbourhood, using HydraDB.
 *
 * This is the step that makes the graph load-bearing. From a handful of seed
 * nodes we walk the real call structure to find everything the task plausibly
 * touches — across files and folders that share no vocabulary, which is exactly
 * what a folder rule or a similarity search cannot do.
 *
 * Direction matters and both are needed:
 *
 *   OUTWARD  (callee)  what the anchor calls   — the implementation beneath it
 *   INWARD   (caller)  what calls the anchor   — the entry points above it
 *
 * A task like "fix duplicate email handling" needs both: the DB write below
 * createVendor, and the route and form above it.
 *
 * Distance is what later separates EXPECTED from CONNECTED from SUSPICIOUS, so
 * it is recorded per member rather than collapsed into a boolean.
 *
 * EVERY member is keyed by its numeric graph id. Keying by anything else means
 * the same function discovered two ways (as an anchor, and again by traversal)
 * becomes two entries at two distances — which then makes "is this edit in
 * scope" answerable two different ways for the same function.
 */

import { GraphClient, gInt } from '../graph/client.js';
import { IdRegistry } from '../ids.js';
import type { Anchor } from './anchors.js';

export interface NeighborhoodMember {
  /** Numeric graph id — the canonical identity. */
  id: number;
  name: string;
  file: string;
  /** Hops from the nearest anchor. 0 means it is an anchor. */
  distance: number;
  /** Why it is here — cited to the developer, never invented. */
  reason: string;
}

export interface Neighborhood {
  task: string;
  terms: string[];
  anchors: Anchor[];
  members: Map<number, NeighborhoodMember>;
  /** Every model anything in the neighbourhood reaches. For display. */
  models: Map<number, { name: string; viaFunction: string }>;
  /**
   * Models the task is actually ABOUT — reached from an anchor only.
   *
   * These two must stay separate or the reasoning goes circular: a peripheral
   * member drags its own models in, those models then count as "the task's
   * data", and the subsystem it belongs to starts looking relevant. Observed:
   * auth entered the neighbourhood at distance 2, User and Session became
   * "task models", and every later auth edit then looked legitimate.
   */
  coreModels: Set<string>;
  stats: {
    anchorCount: number;
    memberCount: number;
    maxDistance: number;
    queryCount: number;
    durationMs: number;
  };
}

export interface BuildOptions {
  /**
   * How far to walk from an anchor.
   *
   * 3 is deliberate. Deeper pulls in half the codebase through shared utilities
   * — a helper called by everything becomes a bridge to everything — and a
   * neighbourhood that contains everything challenges nothing. Precision over
   * recall (PROJECT_FINAL.md §32).
   */
  maxDepth?: number;
  onProgress?: (message: string) => void;
}

export async function buildNeighborhood(
  client: GraphClient,
  task: string,
  anchors: Anchor[],
  terms: string[],
  options: BuildOptions = {},
): Promise<Neighborhood> {
  const started = Date.now();
  const maxDepth = options.maxDepth ?? 3;
  const progress = options.onProgress ?? (() => {});
  const ids = new IdRegistry();

  const members = new Map<number, NeighborhoodMember>();
  const models = new Map<number, { name: string; viaFunction: string }>();
  let queryCount = 0;

  /** Record a member, keeping the shortest distance if it is found twice. */
  const remember = (m: NeighborhoodMember): boolean => {
    const existing = members.get(m.id);
    if (existing && existing.distance <= m.distance) return false;
    members.set(m.id, m);
    return !existing;
  };

  /** Rows come back as {id,name,file}; fold them into the map at one distance. */
  const absorb = (
    records: { get(key: string): unknown }[],
    distance: number,
    reason: (name: string) => string,
  ): number[] => {
    const added: number[] = [];
    for (const record of records) {
      const id = Number(record.get('id'));
      const name = String(record.get('name'));
      const isNew = remember({ id, name, file: String(record.get('file')), distance, reason: reason(name) });
      if (isNew) added.push(id);
    }
    return added;
  };

  // ---- seed --------------------------------------------------------------
  // A Route or Model anchor is not itself editable code, so it seeds the
  // functions attached to it rather than being a member.
  const seeds: number[] = [];

  for (const anchor of anchors) {
    const anchorId = gInt(ids.idFor(anchor.key));

    if (anchor.kind === 'function') {
      // Resolve name/file from the graph so anchors and traversal agree.
      const rows = await client.run(
        `MATCH (f:Function {id: $id}) RETURN f.id AS id, f.name AS name, f.file AS file`,
        { id: anchorId },
      );
      queryCount++;
      seeds.push(...absorb(rows.records, 0, () => `anchor — ${anchor.why}`));
      continue;
    }

    if (anchor.kind === 'route') {
      const rows = await client.run(
        `MATCH (r:Route {id: $id})-[:HANDLED_BY]->(f:Function)
           RETURN f.id AS id, f.name AS name, f.file AS file`,
        { id: anchorId },
      );
      queryCount++;
      seeds.push(...absorb(rows.records, 0, () => `handles ${anchor.name} — ${anchor.why}`));
      continue;
    }

    if (anchor.kind === 'model' || anchor.kind === 'field') {
      const modelKey = anchor.kind === 'model' ? anchor.key : `model:${anchor.name.split('.')[0]}`;
      const rows = await client.run(
        `MATCH (f:Function)-[:TOUCHES]->(m:Model {id: $id})
           RETURN f.id AS id, f.name AS name, f.file AS file`,
        { id: gInt(ids.idFor(modelKey)) },
      );
      queryCount++;
      seeds.push(...absorb(rows.records, 0, () => `touches ${anchor.name} — ${anchor.why}`));
    }
  }

  progress(`${seeds.length} seed functions from ${anchors.length} anchors`);

  // ---- expand ------------------------------------------------------------
  // One hop at a time rather than a variable-length pattern, because we need the
  // distance of each node and a `*1..3` MATCH only projects endpoints.
  let frontier = [...new Set(seeds)];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];

    for (const id of frontier) {
      const fromName = members.get(id)?.name ?? '?';
      const param = gInt(id);

      const callees = await client.run(
        `MATCH (a:Function {id: $id})-[:CALLS]->(b:Function)
           RETURN b.id AS id, b.name AS name, b.file AS file`,
        { id: param },
      );
      queryCount++;
      next.push(...absorb(callees.records, depth, () => `called by ${fromName}`));

      const callers = await client.run(
        `MATCH (b:Function)-[:CALLS]->(a:Function {id: $id})
           RETURN b.id AS id, b.name AS name, b.file AS file`,
        { id: param },
      );
      queryCount++;
      next.push(...absorb(callers.records, depth, () => `calls ${fromName}`));
    }

    frontier = [...new Set(next)];
    if (frontier.length) progress(`depth ${depth}: +${frontier.length} functions`);
  }

  // ---- models the neighbourhood reaches ----------------------------------
  const coreModels = new Set<string>();

  for (const member of members.values()) {
    const touched = await client.run(
      `MATCH (f:Function {id: $id})-[:TOUCHES]->(m:Model)
         RETURN m.id AS id, m.name AS name`,
      { id: gInt(member.id) },
    );
    queryCount++;
    for (const record of touched.records) {
      const modelId = Number(record.get('id'));
      const name = String(record.get('name'));
      if (!models.has(modelId)) models.set(modelId, { name, viaFunction: member.name });
      // Only an anchor speaks for what the task is about.
      if (member.distance === 0) coreModels.add(name);
    }
  }

  const distances = [...members.values()].map((m) => m.distance);

  return {
    task,
    terms,
    anchors,
    members,
    models,
    coreModels,
    stats: {
      anchorCount: anchors.length,
      memberCount: members.size,
      maxDistance: distances.length ? Math.max(...distances) : 0,
      queryCount,
      durationMs: Date.now() - started,
    },
  };
}
