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
import { IdRegistry, nodeKey, repoOf } from '../ids.js';
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
    /** True when the member cap stopped the walk before it finished. */
    truncated: boolean;
    /** Shared functions the walk declined to travel through. Reported, never hidden. */
    hubsSkipped: number;
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
   * recall.
   */
  maxDepth?: number;
  /**
   * How far to walk BACKWARDS, to things that call the task's code.
   *
   * One hop, deliberately, and this is the single most important number here.
   * The two directions are not symmetric:
   *
   *   outward  the task's code calls X — X is probably part of the job
   *   inward   Y calls the task's code — Y is a CONSUMER of it, and every
   *            shared helper has hundreds of those
   *
   * Measured on a real 1,386-file codebase at equal depth: 804 of 1,271 members
   * arrived by walking inward, and the boundary swallowed 56% of the repository.
   * A neighbourhood that contains everything challenges nothing.
   *
   * One hop still catches the case that matters — the form component that calls
   * the submit function belongs to the task — without following every consumer
   * of every utility.
   */
  maxInboundDepth?: number;
  /**
   * Hard ceiling on members — a backstop, not a tuning knob.
   *
   * Set high on purpose. Trimming the walk does not just shrink the boundary, it
   * pushes genuinely-related functions OUTSIDE it, and everything outside gets
   * challenged. A tight cap therefore manufactures exactly the false positives
   * that get a tool uninstalled (rule 1a). Measured on a 1,386-file repo, an
   * honest walk settles at 317; this only fires on something pathological, and
   * says so when it does (rule 2).
   */
  maxMembers?: number;
  /**
   * Refuse to walk through widely-used functions. On by default.
   *
   * Exposed so the ground-truth harness can measure the cost of every
   * restriction rather than assuming each one is free.
   */
  hubRule?: boolean;
  /** Allow `<Child />` edges to chain. Off by default — see the render rule below. */
  renderChains?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Past this many users, a thing is the app's furniture rather than its subject.
 *
 * Applies to anything reached because it is WIDELY USED — a type, a model, a
 * field, or a function the walk arrives at. Each of those otherwise pulls in
 * "everything that uses this", and in a real codebase the shared pieces are used
 * by hundreds of functions. On a 1,386-file product, `Link.linkType` seeded ~200
 * functions before one hop was even walked, so "fix the typo in the delete link
 * confirmation modal" claimed 232 functions at depth 1 and 517 at depth 3.
 *
 * The same line holds for both, measured independently on that codebase:
 *
 *   types      432 used by one function, 185 by two to five, 29 by six to
 *              twenty-five, and only TWO above it
 *   functions  990 with one caller, 482 with two to five, 81 with six to
 *              twenty-five, and 15 of 1,568 above it
 *
 * Two separate distributions with the same shape and the same knee is why this
 * is one constant rather than two tuned numbers. And the fifteen it excludes are
 * unambiguous: `cn` (232 callers), `useTeam` (202), `errorhandler` (100), `log`,
 * `AppLayout`, `DialogHeader`, `DialogFooter`, `BadgeTooltip`, `LoadingSpinner`
 * — the design system and the utility drawer. Nothing there is ever the job.
 *
 * A thing that genuinely IS the subject sits well under the line: `LinkWithViews`
 * had 22 users. And naming beats reach — an anchor is seeded before the walk
 * begins, so "refactor the cn helper" still works. This only governs what is
 * reached BY TRAVERSAL, where being popular is not evidence of being relevant.
 */
const MAX_SHAPE_USERS = 25;

/**
 * How many of the top anchors get to say what the task is ABOUT.
 *
 * Finding all the code a task touches and identifying its subject are different
 * questions needing different amounts of evidence. The anchor net is 60 wide
 * because a narrower one missed real work — but letting all 60 vote on the
 * subject let a weak anchor's models become "the task's data", which then made
 * an unrelated subsystem's edits look legitimate. Twelve was the right size for
 * this job all along; it was only ever the wrong size for the other one.
 */
const SUBJECT_ANCHORS = 12;

/**
 * A note on what was tried before the single fetch, so it is not tried again.
 *
 * The walk used to ask one question per node and the obvious fix looked like
 * parallelism: 120 of those queries take 1,836ms serially, 107ms eight at a time,
 * 69ms sixteen. In the real CLI it then died with "Connection acquisition timed out
 * in 60000 ms" at width 12 and again at width 4 — this engine does not tolerate
 * concurrent sessions under load, however well it benchmarks idle.
 *
 * Batching by id is also unavailable: it rejects `UNWIND $ids AS id MATCH (a {id: id})`
 * and `WHERE id IN $ids` alike.
 *
 * What worked was asking FEWER questions rather than faster ones — see
 * `loadCallGraph`.
 */

/** The row shape the walk reads. Matches a Bolt record closely enough to swap in. */
type Row = { get(key: string): unknown };

/**
 * WHY THE WALK ASKS ONE QUESTION PER NODE, MEASURED.
 *
 * The obvious fix for 341 round trips is to fetch the repository's call edges in
 * ONE query and walk them in memory. That was built, gated for correctness — both
 * paths produce byte-identical boundaries — and then measured, and it LOSES on
 * both axes that matter:
 *
 *                          per-node        one whole-repo query
 *   one project loaded     1,601ms          4,977ms
 *   five projects loaded   slow, finishes   TIMES OUT at 30s
 *
 * The reason is that this engine has no property indexes — `CREATE INDEX` is
 * rejected in every form — so `{repo: …}` cannot be sought, only scanned, and a
 * scan grows with the whole DATABASE rather than this repo. An id lookup does not:
 *
 *   callees of one id, one project loaded      4.7ms
 *   callees of one id, five projects loaded     47ms
 *   one File by {repo} with LIMIT 1, five     146,418ms
 *
 * So many cheap seeks beat one expensive scan here, and `LIMIT 1` saves nothing
 * when there is nothing to seek on. Parallelising the seeks is also out: it
 * benchmarked 1,836ms → 69ms at width 16 and then died with "Connection
 * acquisition timed out in 60000 ms" in the real CLI at width 12 AND at width 4.
 *
 * `scripts/boundary-gate.ts` is what remains of the attempt, and it is worth
 * keeping: any future change to this walk has to prove the boundary is unchanged.
 */

/**
 * How many distinct PLACES these rows represent.
 *
 * A place is a top-level declaration. Counting rows instead counts a component's
 * handlers separately from the component, which inflates every "how shared is
 * this" measurement the moment nested functions became visible.
 */
function distinctPlaces(records: { get(key: string): unknown }[]): number {
  const places = new Set<string>();
  for (const record of records) places.add(String(record.get('root') ?? record.get('id')));
  return places.size;
}

export async function buildNeighborhood(
  client: GraphClient,
  task: string,
  anchors: Anchor[],
  terms: string[],
  options: BuildOptions = {},
): Promise<Neighborhood> {
  const started = Date.now();
  /**
   * One hop, not three — and this was decided by measurement, not taste.
   *
   * Three hops was chosen on an eleven-file demo. On a real 1,362-file product,
   * measured against 30 real commits, depth 1 with good anchors beats depth 3
   * with poor ones on BOTH counts at once: fewer correct edits challenged, and a
   * task area less than half the size. Going to depth 2 buys another 2.4 points
   * of quiet but doubles the area to a fifth of the whole repository, which is
   * too much of the codebase to fall silent about.
   */
  const maxDepth = options.maxDepth ?? 1;
  const maxInboundDepth = options.maxInboundDepth ?? 1;
  const maxMembers = options.maxMembers ?? 800;
  let truncated = false;
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

  /**
   * Seeds from the strongest anchors only — what the task is ABOUT.
   *
   * Finding every function a task touches and deciding what the task is about
   * are different jobs and want different amounts of evidence. Widening the
   * anchor net from 12 to 60 was right for the first and wrong for the second:
   * weak anchors landed at distance 0, their models were counted as the task's
   * own data, and a "clean up a helper in auth/session.ts" over-reach stopped
   * being suspicious because auth's models now looked like the task's models.
   *
   * That is the circular reasoning this file already warns about under
   * `coreModels`, arriving by a new route. The subject stays with the top few.
   */
  const coreSeeds = new Set<number>();

  /** Shape anchors held back as too general — kept in case they are all we have. */
  const skippedShapes: {
    anchor: Anchor;
    records: { get(key: string): unknown }[];
    places: number;
    reason: string;
  }[] = [];

  for (const [rank, anchor] of anchors.entries()) {
    const anchorId = gInt(ids.idFor(anchor.key));
    /** Anchors are sorted by score, so rank is strength of evidence. */
    const speaksForTheTask = rank < SUBJECT_ANCHORS;
    /** Every branch below seeds through this, so none can forget the marking. */
    const seed = (added: number[]) => {
      seeds.push(...added);
      if (speaksForTheTask) for (const id of added) coreSeeds.add(id);
    };

    if (anchor.kind === 'function') {
      // Resolve name/file from the graph so anchors and traversal agree.
      const rows = await client.run(
        `MATCH (f:Function {id: $id}) RETURN f.id AS id, f.name AS name, f.file AS file`,
        { id: anchorId },
      );
      queryCount++;
      seed(absorb(rows.records, 0, () => `anchor — ${anchor.why}`));
      continue;
    }

    if (anchor.kind === 'type') {
      // A type is not editable code on its own, so it seeds the functions that
      // USE it — which is how "add a status field to the Vendor type" finds the
      // handlers, serialisers and components that would have to change with it.
      const rows = await client.run(
        `MATCH (f:Function)-[:REFERENCES]->(t:Type {id: $id})
           RETURN f.id AS id, f.name AS name, f.file AS file, f.root AS root`,
        { id: anchorId },
      );
      queryCount++;

      // A type everything uses defines nothing.
      //
      // Measured on a 1,386-file codebase: of 648 types, 432 are used by a single
      // function and only TWO by more than 25 — `CustomUser` at 228 and a config
      // union at 42. Those are shared shapes, not subjects; seeding every user of
      // one is the same mistake as walking inward through a shared helper, and it
      // pushed a boundary to 800 functions. A genuinely focused type sits well
      // under the line: `LinkWithViews`, the actual subject of that task, had 22.
      const places = distinctPlaces(rows.records);
      if (places > MAX_SHAPE_USERS) {
        skippedShapes.push({ anchor, records: rows.records, places, reason: 'used by' });
        progress(`${anchor.name} is used in ${places} places — too general to define a task`);
        continue;
      }

      seed(absorb(rows.records, 0, () => `uses ${anchor.name}`));
      continue;
    }

    if (anchor.kind === 'route') {
      const rows = await client.run(
        `MATCH (r:Route {id: $id})-[:HANDLED_BY]->(f:Function)
           RETURN f.id AS id, f.name AS name, f.file AS file`,
        { id: anchorId },
      );
      queryCount++;
      seed(absorb(rows.records, 0, () => `handles ${anchor.name} — ${anchor.why}`));
      continue;
    }

    if (anchor.kind === 'model' || anchor.kind === 'field') {
      // A field anchor names its model, and that model key must carry the same
      // repo prefix the anchor does — otherwise it points at no node, or worse,
      // at another project's model of the same name.
      const modelKey =
        anchor.kind === 'model'
          ? anchor.key
          : nodeKey(repoOf(anchor.key), 'model', anchor.name.split('.')[0]);
      const rows = await client.run(
        `MATCH (f:Function)-[:TOUCHES]->(m:Model {id: $id})
           RETURN f.id AS id, f.name AS name, f.file AS file, f.root AS root`,
        { id: gInt(ids.idFor(modelKey)) },
      );
      queryCount++;
      const places = distinctPlaces(rows.records);
      if (places > MAX_SHAPE_USERS) {
        skippedShapes.push({ anchor, records: rows.records, places, reason: 'touched in' });
        progress(
          `${anchor.name} is touched in ${places} places — the app's core entity, not this task`,
        );
        continue;
      }
      seed(absorb(rows.records, 0, () => `touches ${anchor.name} — ${anchor.why}`));
    }
  }

  /**
   * An empty boundary is the worst outcome there is.
   *
   * Nothing is inside it, so EVERY edit is outside the task and gets challenged
   * — the tool turns into pure noise on exactly the tasks it understood least.
   * That is strictly worse than a boundary that is too wide, and it is a real
   * failure that happened: a type used in 43 places was discarded as furniture,
   * and since it was the task's only shape anchor the walk started from nothing.
   *
   * So the general-shape rule is a PREFERENCE, not a veto. If holding those
   * anchors back leaves us with no way in at all, take the most specific one we
   * held back and say so, rather than returning an empty answer.
   */
  if (seeds.length === 0 && skippedShapes.length > 0) {
    const narrowest = skippedShapes.reduce((a, b) => (a.places <= b.places ? a : b));
    progress(
      `no other way in — falling back to ${narrowest.anchor.name}, ` +
        `${narrowest.reason} ${narrowest.places} places`,
    );
    seeds.push(...absorb(narrowest.records, 0, () => `uses ${narrowest.anchor.name}`));
  }

  progress(`${seeds.length} seed functions from ${anchors.length} anchors`);

  // ---- the shared pieces the walk must not travel through ----------------
  // One query for the whole graph rather than a caller count per node as we go:
  // the walk visits hundreds of nodes and would otherwise ask the same question
  // about `cn` from every one of them.
  // Pairs rather than a grouped count, because the thing being counted is
  // distinct CALLING PLACES, and a place is a top-level declaration — see the
  // `root` property in graph/write.ts. Two handlers of one component calling
  // `cn` is one place using it, not two.
  // Only asked when the rule is on — this pulls every call edge in the project,
  // and running it to build a map nobody reads was pure waste.
  //
  // Scoped to one repository: "how many places use this" counted across every
  // project in the database would make a helper look shared because a DIFFERENT
  // codebase happens to use one of the same name.
  /**
   * The whole repo's call edges, once.
   *
   * This replaces BOTH the per-node walk below and the separate hub-count query,
   * which were two scans of the same relationships. See `loadCallGraph`.
   */
  const repoId = anchors.length ? repoOf(anchors[0].key) : '';

  /** One node's edges, by id — the only shape this engine answers cheaply. */
  const edgesOf = async (id: number, direction: 'out' | 'in'): Promise<Row[]> => {
    queryCount++;
    const rows = await client.run(
      direction === 'out'
        ? `MATCH (a:Function {id: $id})-[c:CALLS]->(b:Function)
             RETURN b.id AS id, b.name AS name, b.file AS file, c.render AS render, c.contains AS contains`
        : `MATCH (b:Function)-[c:CALLS]->(a:Function {id: $id})
             RETURN b.id AS id, b.name AS name, b.file AS file, c.render AS render`,
      { id: gInt(id) },
    );
    return rows.records;
  };

  /**
   * Caller counts for the hub rule, in one query for the whole repo.
   *
   * The one place a whole-repo scan is still the right shape: the walk visits
   * hundreds of nodes and would otherwise ask the same question about `cn` from
   * every one of them. Only asked when the rule is on, which it is not by default.
   */
  const callerPlaces = new Map<number, Set<string>>();
  if (options.hubRule === true) {
    const hubRows = await client.run(
      `MATCH (a:Function {repo: $repo})-[c:CALLS]->(b:Function)
         RETURN b.id AS id, a.root AS caller, c.contains AS contains`,
      { repo: repoId },
    );
    queryCount++;
    for (const record of hubRows.records) {
      // A parent "calling" the function it declares is not a user of it.
      if (record.get('contains') === true) continue;
      const id = Number(record.get('id'));
      const places = callerPlaces.get(id) ?? new Set<string>();
      places.add(String(record.get('caller')));
      callerPlaces.set(id, places);
    }
  }
  /**
   * The hub rule is OFF by default, and this reverses an earlier decision of mine.
   *
   * It was justified on boundary SIZE alone — 15 functions with more than 25
   * callers, all of them design-system and utility code, and refusing to walk
   * through them cut a bloated boundary down usefully. That reasoning was fine
   * as far as it went, and it went the wrong way: shared code is often exactly
   * what a task is about. `sendEmail` has 38 callers, and "add emails and slack
   * invitation" is a task ABOUT `sendEmail`.
   *
   * Measured against real commits it is net negative on every axis that matters
   * — turning it off lowered wrongly challenged edits from 19.3% to 15.7% AND
   * raised how much of the real work landed inside the boundary, for 0.6% more
   * area. Size was the wrong thing to have optimised.
   */
  const hubs = new Map<number, number>();
  if (options.hubRule === true) {
    for (const [id, places] of callerPlaces) {
      if (places.size > MAX_SHAPE_USERS) hubs.set(id, places.size);
    }
  }

  /**
   * Anchors outrank the hub rule.
   *
   * "refactor the cn helper" names `cn` directly, and a task is allowed to be
   * about a shared thing. What is not allowed is REACHING one and treating
   * everything on its far side as part of the job.
   */
  for (const id of seeds) hubs.delete(id);

  const hubsSkipped = new Map<string, number>();

  /** Members that entered the walk as `<Child />`. See the render rule below. */
  const renderArrivals = new Set<number>();

  // ---- expand ------------------------------------------------------------
  // One hop at a time rather than a variable-length pattern, because we need the
  // distance of each node and a `*1..3` MATCH only projects endpoints.
  let frontier = [...new Set(seeds)];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];

    // A worklist rather than a fixed list: functions pulled in by containment
    // belong to THIS depth, so they have to be expanded in this round too.
    // Containment cannot cycle, so this always terminates.
    const current = [...frontier];

    /**
     * No fetching. The whole call graph is already in memory, so a level of the
     * walk is a map lookup per node rather than a round trip per node.
     */
    const fetched = [];
    for (const id of current) {
      fetched.push({
        id,
        callees: { records: await edgesOf(id, 'out') },
        callers: depth <= maxInboundDepth ? { records: await edgesOf(id, 'in') } : undefined,
      });
    }

    for (const { id, callees, callers: callerRows } of fetched) {
      const fromName = members.get(id)?.name ?? '?';

      /** Drop the shared pieces, and record what was dropped (rule 2). */
      const withoutHubs = (records: { get(key: string): unknown }[]) =>
        records.filter((record) => {
          const callers = hubs.get(Number(record.get('id')));
          if (callers === undefined) return true;
          hubsSkipped.set(String(record.get('name')), callers);
          return false;
        });

      /**
       * Rendering does not chain.
       *
       * `<Child />` is composition, not dependency: a page assembles twenty
       * widgets that have nothing to do with each other. Following one render
       * edge from the task's own code is right — you may well have to pass the
       * child a prop. Following a SECOND one, out of a component you only
       * reached by rendering, walks into someone else's feature.
       *
       * Measured: a third of all call edges in a React codebase come from JSX,
       * and this chain is what let "the dataroom folder tree does not refresh"
       * arrive at a PDF viewer's icon components three hops out.
       */
      const arrivedByRender = options.renderChains !== true && renderArrivals.has(id);
      const keep = (records: { get(key: string): unknown }[]) =>
        withoutHubs(records).filter((record) => !(arrivedByRender && record.get('render') === true));

      /**
       * Only mark a member as render-arrived if rendering is the ONLY way it got
       * here. A component that is both called and rendered by the same parent —
       * `useThing()` alongside `<Thing />` — is a real dependency, and treating
       * it as decoration would stop the walk one hop early.
       */
      const noteRenders = (records: { get(key: string): unknown }[], added: number[]) => {
        const called = new Set<number>();
        const rendered = new Set<number>();
        for (const record of records) {
          const id = Number(record.get('id'));
          (record.get('render') === true ? rendered : called).add(id);
        }
        for (const id of added) if (rendered.has(id) && !called.has(id)) renderArrivals.add(id);
      };

      // A function declared inside this one IS this one, for scope purposes, so
      // it joins at the same distance rather than a hop further out. Charging it
      // a hop would push a component's own handlers toward the edge of its own
      // task area — and the handlers are usually where the work actually is.
      const contained = callees.records.filter((record) => record.get('contains') === true);
      const inherited = members.get(id)?.distance ?? depth;
      current.push(...absorb(contained, inherited, () => `declared inside ${fromName}`));

      const kept = keep(callees.records.filter((record) => record.get('contains') !== true));
      const addedOut = absorb(kept, depth, () => `called by ${fromName}`);
      noteRenders(kept, addedOut);
      next.push(...addedOut);

      // Consumers, only close to the anchors. See maxInboundDepth.
      if (callerRows) {
        // Inbound is not filtered by the render rule: the page that renders the
        // component you are changing is genuinely above it, and inbound is
        // already held to one hop.
        const addedIn = absorb(withoutHubs(callerRows.records), depth, () => `calls ${fromName}`);
        next.push(...addedIn);
      }

      if (members.size >= maxMembers) {
        truncated = true;
        break;
      }
    }

    frontier = [...new Set(next)];
    if (truncated) {
      progress(`stopped at ${members.size} functions — the task area is larger than the cap`);
      break;
    }
    if (frontier.length) progress(`depth ${depth}: +${frontier.length} functions`);
  }

  if (hubsSkipped.size) {
    const named = [...hubsSkipped.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, callers]) => `${name} (${callers} callers)`);
    progress(
      `did not walk through ${hubsSkipped.size} shared function${hubsSkipped.size === 1 ? '' : 's'}: ` +
        `${named.join(', ')}${hubsSkipped.size > named.length ? ', …' : ''}`,
    );
  }

  // ---- models the neighbourhood reaches ----------------------------------
  const coreModels = new Set<string>();

  // One query per member, fetched in slices for the same reason as the walk
  // above: a 393-member boundary is 393 more round trips, and they are all
  // independent. Folded in member order so `viaFunction` stays deterministic.
  for (const member of members.values()) {
    queryCount++;
    const touched = (
      await client.run(
        `MATCH (f:Function {id: $id})-[:TOUCHES]->(m:Model) RETURN m.id AS id, m.name AS name`,
        { id: gInt(member.id) },
      )
    ).records;

    for (const record of touched) {
      const modelId = Number(record.get('id'));
      const name = String(record.get('name'));
      if (!models.has(modelId)) models.set(modelId, { name, viaFunction: member.name });
      // Only a STRONG anchor speaks for what the task is about — see coreSeeds.
      if (coreSeeds.has(member.id)) coreModels.add(name);
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
      truncated,
      hubsSkipped: hubsSkipped.size,
      durationMs: Date.now() - started,
    },
  };
}
