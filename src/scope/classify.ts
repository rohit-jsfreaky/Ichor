/**
 * Decide whether a change still belongs to the task.
 *
 * THE TWO TESTS (CLAUDE.md — if you only implement the first, the demo fails):
 *
 *   TEST 1  Is this connected to the task?          graph reachability
 *   TEST 2  Does an existing path already do this?  the new-flow test
 *
 * Test 2 is the one nothing else can do. A new /api/vendors/check-email route
 * PASSES test 1 — it imports Prisma, queries Vendor by email, sits with the
 * other vendor routes. It is wrong because the submit path already reaches the
 * `email @unique` constraint, so it is a second flow for a rule already
 * enforced.
 *
 * Silence is the default. When uncertain we stay quiet: a tool that questions
 * every third edit is uninstalled the same afternoon.
 */

import type { GraphClient } from '../graph/client.js';
import { gInt } from '../graph/client.js';
import type { Neighborhood } from './neighborhood.js';
import type { PendingFacts } from './pending.js';
import { namedTokens } from './named.js';

/**
 * `NOT_JUDGED` is not a softer `CONNECTED`. It means Ichor has no standing here.
 *
 * A verdict is a claim about structure, and Ichor only has structure for code it
 * parsed. Calling a `.json` file CONNECTED would assert a connection it never
 * found; calling it SUSPICIOUS asserts scope expansion from no evidence at all —
 * which is what it used to do, challenging `locales/en/viewer.json` during a task
 * about changing exactly that message.
 */
export type Decision = 'EXPECTED' | 'CONNECTED' | 'NOT_JUDGED' | 'SUSPICIOUS' | 'HUMAN_REVIEW';

export interface Evidence {
  kind: 'path' | 'member' | 'model' | 'existing-flow' | 'note';
  text: string;
}

export interface Verdict {
  decision: Decision;
  /** One sentence, shown to the agent. Always cites something real. */
  reason: string;
  evidence: Evidence[];
  /** Only present when we are challenging — what the agent must answer. */
  question?: string;
  /** True when a Judge call is warranted (ambiguous, not obvious). */
  needsJudge: boolean;
}

/**
 * Will this verdict actually interrupt the agent?
 *
 * One owner for the question, because three places were answering it differently.
 * The hook and the MCP tool both stopped on `SUSPICIOUS` or `HUMAN_REVIEW`, while
 * the false-alarm harness counted `needsJudge` — which the no-content
 * `HUMAN_REVIEW` branch sets to false. So the harness reported **0% false alarms**
 * on 86 real edits while 73 of them would have interrupted a real session.
 *
 * A measurement that disagrees with the thing it measures is worse than no
 * measurement: it reads as evidence.
 */
export function isChallenge(verdict: Pick<Verdict, 'decision'>): boolean {
  return verdict.decision === 'SUSPICIOUS' || verdict.decision === 'HUMAN_REVIEW';
}

export interface ChangeIntent {
  operation: 'edit' | 'create' | 'delete';
  /** Repo-relative, POSIX. */
  file: string;
  /** Proposed content, when the host provides it. */
  content?: string;
  /**
   * The exact substitution an edit will make, when the host reports one.
   *
   * Lets the caller reconstruct the WHOLE proposed file — the version on disk at
   * PreToolUse is still the old one — rather than parsing `new_string` as if a
   * fragment were a module.
   */
  replace?: { from: string; to: string };
}

/**
 * Distance at which membership still means "this IS the task".
 *
 * Zero, deliberately. An anchor is a place the task text pointed at directly.
 * Anything further is *reachable from* the task, which is a weaker claim and
 * has to be corroborated by the data the code works on — otherwise every file
 * a route happens to call (auth, logging, config) reads as part of every task.
 *
 * Distance >0 is not treated as suspicious by itself; it goes to the model
 * overlap check, and a shared-data result is CONNECTED and silent.
 */
const EXPECTED_MAX_DISTANCE = 0;

export interface ClassifyDeps {
  client: GraphClient;
  neighborhood: Neighborhood;
  /**
   * Which project this edit belongs to.
   *
   * Every query below that matches on a PATH or a NAME rather than an id needs
   * it. `src/lib/db.ts` and a model called `User` exist in most projects, so
   * without the filter a second project in the same database would answer for
   * the first — and the answer would look entirely reasonable, which is the
   * dangerous kind of wrong.
   */
  repo: string;
  /** Parsed pending content, when the operation carries content. */
  pending?: PendingFacts;
  /**
   * True only when `pending` was parsed from the COMPLETE proposed file.
   *
   * Defaults to false, because the safe reading of a fragment is "I do not know
   * what this file will contain". An `Edit` payload carries `new_string` alone, and
   * treating that as the whole module makes every name outside the fragment look
   * deleted — which challenged a perfectly ordinary edit to `createVendor` for
   * "no longer exporting" the two functions the fragment did not happen to mention.
   * Caught by the hook suite the moment the surface check was added.
   */
  wholeFile?: boolean;
  /**
   * Files that were challenged and then written anyway, without ever being
   * justified.
   *
   * They are real code and they are in the graph, but they are not precedent.
   * Citing one as "an existing path already does this" would let an agent clear
   * a challenge by retrying, and then use the very code it forced through as
   * the argument against the next change.
   */
  forced?: string[];
}

/**
 * Files so generically named that seeing the word proves nothing.
 *
 * "update the route" must not put every `route.ts` in the repo beyond question.
 */
/** The file types Ichor compiles into the graph. Anything else it cannot read. */
const ANALYSED = /\.(ts|tsx|prisma)$/;

const GENERIC_FILENAMES = new Set([
  'index.ts', 'index.tsx', 'page.tsx', 'page.ts', 'route.ts', 'route.tsx',
  'layout.tsx', 'types.ts', 'utils.ts', 'config.ts', 'main.ts', 'app.tsx',
]);

/**
 * Did the developer name this exact file in the task?
 *
 * A file that does not exist yet cannot be anchored — there is nothing in the
 * graph to match — so "create lib/test-widget.ts with a signup helper" drew a
 * boundary that could not contain the one file the sentence was about, and Ichor
 * challenged it: *"lib/test-widget.ts is new and Ichor found no connection to the
 * task"*. Measured in a live session, where the agent had to answer back that the
 * file WAS the task. A tool that questions the thing it was just asked for is a
 * tool people stop believing.
 *
 * The path decides it, because the path is the developer stating their intent
 * outright rather than any inference about it (ENGINEERING-RULES rule 1a). A bare
 * filename counts only when it is distinctive enough to mean one thing.
 */
export function taskNamesFile(task: string, file: string): boolean {
  const said = task.toLowerCase().replace(/\\/g, '/');
  const wanted = file.toLowerCase().replace(/\\/g, '/');
  if (!wanted) return false;
  if (said.includes(wanted)) return true;

  const base = wanted.slice(wanted.lastIndexOf('/') + 1);
  if (base.length < 6 || GENERIC_FILENAMES.has(base)) return false;
  return said.includes(base);
}

export async function classify(intent: ChangeIntent, deps: ClassifyDeps): Promise<Verdict> {
  const { neighborhood } = deps;
  const evidence: Evidence[] = [];

  // ---- a Prisma schema ----------------------------------------------------
  //
  // Judged by the MODELS it declares, not by functions, because it declares none.
  // Every branch below asks about reachability between functions and would find
  // nothing here — which used to mean every schema edit was challenged, including
  // one adding the field the task was about.
  if (/\.prisma$/.test(intent.file)) {
    const schema = await prismaSchemaEdit(intent.file, deps);
    if (schema) return schema;
  }

  // ---- a file Ichor never read -------------------------------------------
  //
  // Checked first, because every branch below reasons about declarations, calls
  // and reachability — and none of those exist for a file the analyser does not
  // parse. Reaching the end of this function with a `.json` path returned
  // SUSPICIOUS on the strength of finding nothing, which is not evidence.
  if (!isAnalysed(intent.file)) {
    const unread = await unreadableFile(intent, deps);
    if (unread) return unread;
  }

  // ---- the file's public surface is shrinking ------------------------------
  //
  // Ahead of every reachability branch, because those answer "is this file near
  // the task" and this asks a different question: does the edit break code that
  // is not in the task at all. `lib/utils.ts` was CONNECTED — correctly, it is one
  // hop away — and gutting it of a helper used in 232 places passed in silence.
  const surface = await shrinkingSurface(intent, deps);
  if (surface) return surface;

  const membersInFile = [...neighborhood.members.values()].filter((m) => m.file === intent.file);

  // ---- existing file, but nothing in it belongs to the task ---------------
  // Distinct from a genuinely new file. A file that exists in the graph and has
  // no member here is code the task never reaches — the "I was cleaning up a
  // helper while I was here" case.
  if (membersInFile.length === 0) {
    const outside = await existingFileOutsideTask(intent.file, deps);
    if (outside) return outside;
  }

  // ---- existing file, part of the task ------------------------------------
  if (membersInFile.length > 0) {
    const nearest = membersInFile.reduce((a, b) => (a.distance <= b.distance ? a : b));

    for (const m of membersInFile.slice(0, 4)) {
      evidence.push({ kind: 'member', text: `${m.name} (distance ${m.distance}) — ${m.reason}` });
    }

    if (nearest.distance <= EXPECTED_MAX_DISTANCE) {
      return {
        decision: 'EXPECTED',
        reason: `${intent.file} is part of the task neighbourhood (${nearest.name}, distance ${nearest.distance}).`,
        evidence,
        needsJudge: false,
      };
    }

    // Further out. Distance alone is not enough here: auth/session.ts is two
    // hops from the route simply because the route authenticates, yet it has
    // nothing to do with a duplicate-email bug. The signal that separates them
    // is whether the file works on the same DATA as the task.
    /**
     * Judge the FILE's data, not just the member's.
     *
     * The unit being edited is a file, and `existingFileOutsideTask` already
     * asks what the whole file works on. Asking only what the matched members
     * touch made the same question answerable two ways: `auth/session.ts` has
     * one function one hop from the task, `requireSession`, which touches no
     * model at all — so the overlap came back empty and a "while I was in here"
     * cleanup of an auth file read as connected, even though everything else in
     * that file works on Session and User and the task is about Vendor.
     */
    const overlap = await modelOverlap(deps, await functionsDeclaredIn(intent.file, deps));
    const taskModels = neighborhood.coreModels;

    if (overlap.shared.length > 0) {
      evidence.push({
        kind: 'model',
        text: `works on ${overlap.shared.join(', ')}, which the task also touches`,
      });
      return {
        decision: 'CONNECTED',
        reason: `${intent.file} is ${nearest.distance} hops from the task but works on the same data (${overlap.shared.join(', ')}).`,
        evidence,
        needsJudge: false,
      };
    }

    if (overlap.foreign.length > 0) {
      evidence.push({
        kind: 'model',
        text: `works on ${overlap.foreign.join(', ')}; the task works on ${[...taskModels].join(', ') || 'no models'}`,
      });
      return {
        decision: 'SUSPICIOUS',
        reason:
          `${intent.file} is reachable from the task only through ${nearest.name} (distance ${nearest.distance}), ` +
          `and it operates on ${overlap.foreign.join(', ')} rather than the data this task is about.`,
        evidence,
        question: `Why does "${neighborhood.task}" require a change in ${intent.file}?`,
        needsJudge: true,
      };
    }

    // Reachable, touches no data either way. Genuinely ambiguous — a shared
    // helper legitimately looks like this, so we do not challenge on our own.
    return {
      decision: 'CONNECTED',
      reason: `${intent.file} is ${nearest.distance} hops from the task via ${nearest.name}.`,
      evidence,
      needsJudge: false,
    };
  }

  // ---- new file -----------------------------------------------------------
  // Being new is not suspicious. Legitimate work creates tests, components and
  // modules constantly. What matters is what it reaches.
  const pending = deps.pending;

  if (!pending) {
    /**
     * A file Ichor cannot read is not evidence of anything.
     *
     * Ichor analyses TypeScript. A .css, .json, .md or .yml file can never be in
     * the graph, so "not in the graph" says nothing about it — and challenging on
     * that basis is asserting scope expansion from no evidence at all, which is
     * the one thing this codebase must not do (ENGINEERING-RULES rule 3).
     *
     * Seen in a live Codex session, where the task was literally "go to css file
     * and lets do some random css add" and Ichor challenged app/globals.css for
     * being unreadable. The agent overrode it, correctly, and every challenge
     * after that starts from a worse position.
     *
     * Allowed with a note. The Stop handler still names it, so the change is
     * recorded rather than lost — it simply is not called scope expansion.
     */
    if (!ANALYSED.test(intent.file)) {
      return {
        decision: 'NOT_JUDGED',
        reason: `${intent.file} is not a file type Ichor analyses, so it has no basis to judge it.`,
        evidence: [{ kind: 'note', text: 'outside the analysed file types (TypeScript, Prisma)' }],
        needsJudge: false,
      };
    }

    evidence.push({ kind: 'note', text: 'no content available for a file outside the graph' });
    return {
      decision: 'HUMAN_REVIEW',
      reason: `${intent.file} is not in the graph and no content was provided, so it cannot be assessed.`,
      evidence,
      question: `What is ${intent.file} for, and how does it serve "${neighborhood.task}"?`,
      needsJudge: false,
    };
  }

  if (pending.parseError) {
    evidence.push({ kind: 'note', text: `could not parse: ${pending.parseError}` });
    return {
      decision: 'CONNECTED',
      reason: `${intent.file} could not be parsed, so Ichor is staying out of the way.`,
      evidence,
      needsJudge: false,
    };
  }

  if (pending.isTest) {
    return {
      decision: 'EXPECTED',
      reason: `${intent.file} is a test. Adding tests for a fix is expected.`,
      evidence: [{ kind: 'note', text: 'test files are always in scope' }],
      needsJudge: false,
    };
  }

  // TEST 1 — does it reach the task?
  const reach = reachIntoNeighborhood(pending, neighborhood);
  for (const hit of reach.evidence) evidence.push(hit);

  // TEST 2 — does an existing path already do this?
  const duplicate = await findDuplicateFlow(pending, deps);
  if (duplicate) {
    evidence.push({ kind: 'existing-flow', text: duplicate.existingPath });
    // Say HOW it reaches the model. Routing through a service instead of the
    // database client is good practice, and an agent told it "reaches Vendor"
    // when its file contains no query would rightly think Ichor was confused.
    const reaches = duplicate.viaFile
      ? `reaches ${duplicate.model} through ${duplicate.viaFile}`
      : `reaches ${duplicate.model}`;
    return {
      decision: 'SUSPICIOUS',
      reason:
        `${intent.file} introduces a new ${duplicate.newFlowKind} that ${reaches}, ` +
        `but the task's existing path already reaches it: ${duplicate.existingPath}.`,
      evidence,
      question:
        `The existing ${duplicate.existingEntry} already reaches ${duplicate.model}` +
        `${duplicate.constraintNote}. Why is a separate ${duplicate.newFlowKind} required?`,
      needsJudge: true,
    };
  }

  if (reach.connected) {
    return {
      decision: 'CONNECTED',
      reason: `${intent.file} is new but connects to the task (${reach.summary}).`,
      evidence,
      needsJudge: false,
    };
  }

  // Asked for by name. The answer to "why does this file exist" is in the task
  // sentence itself, so there is nothing to ask about.
  if (taskNamesFile(neighborhood.task, intent.file)) {
    return {
      decision: 'EXPECTED',
      reason: `${intent.file} is named in the task itself.`,
      evidence: [{ kind: 'note', text: 'the task names this file directly' }],
      needsJudge: false,
    };
  }

  return {
    decision: 'SUSPICIOUS',
    reason: `${intent.file} is new and Ichor found no connection to the task.`,
    evidence: evidence.length ? evidence : [{ kind: 'note', text: 'no imports or calls reach the task neighbourhood' }],
    question: `How does ${intent.file} serve "${neighborhood.task}"?`,
    needsJudge: true,
  };
}

// ---------------------------------------------------------------- internals

/**
 * Does the analyser actually read this file type?
 *
 * The honest list, kept next to the thing that decides it. `.prisma` is here
 * because the schema parser reads it and its models become real nodes; a `.json`
 * dictionary or a stylesheet is not, however much a task might be about one.
 */
function isAnalysed(file: string): boolean {
  if (/\.d\.ts$/.test(file)) return false;
  return /\.(ts|tsx|prisma)$/.test(file);
}

/**
 * Is this edit removing something other code depends on?
 *
 * THE DISTINCTION THAT MATTERS
 *
 * Not which file was touched — whether the change alters what OTHER code is
 * entitled to rely on. Rewriting a function's insides is ordinary work. Removing
 * one that 232 places import is a different act, and during a task about message
 * wording it is scope expansion however near the file happens to sit.
 *
 * The case this exists for: mid-task, an agent pulled `cn` out of `lib/utils.ts`
 * into a new file. The new file was caught. Gutting the shared one returned
 * CONNECTED and said nothing.
 *
 * FOUR CONDITIONS, ALL REQUIRED
 *
 *   1  the proposed file was reconstructed and parsed — no guessing from a fragment
 *   2  a name the graph records as exported is GONE from it
 *   3  the task never named this file
 *   4  the graph shows real dependents, and the count is quoted
 *
 * Condition 3 is what keeps this quiet during honest refactoring: a developer who
 * says "refactor lib/utils.ts" gets no argument about refactoring lib/utils.ts.
 */
async function shrinkingSurface(
  intent: ChangeIntent,
  deps: ClassifyDeps,
): Promise<Verdict | undefined> {
  const pending = deps.pending;
  if (!pending || pending.parseError || intent.operation !== 'edit') return undefined;
  // Without the complete file, "this name is gone" cannot be told apart from
  // "this name is not in the part I was shown".
  if (!deps.wholeFile) return undefined;
  // A partly-applied edit is often unbalanced, and a recovered parse stops at the
  // break — so everything after it reads as removed. See PendingFacts.syntaxErrors.
  if (pending.syntaxErrors > 0) return undefined;
  if (!isAnalysed(intent.file) || pending.isTest) return undefined;

  const fileId = await fileNodeId(intent.file, deps);
  if (fileId === undefined) return undefined;

  // What the graph says this file exports today.
  const rows = await deps.client.run(
    `MATCH (f:File {id: $id})-[:DECLARES]->(fn:Function {exported: true}) RETURN fn.name AS name`,
    { id: gInt(fileId) },
  );
  const before = rows.records.map((r) => String(r.get('name')));
  if (before.length === 0) return undefined;

  /**
   * Only top-level names are compared.
   *
   * The graph records a method as `VendorForm.handleSubmit`, and the parser
   * reports the exported `VendorForm`. Treating the method as a lost export would
   * challenge every component edit.
   */
  const after = new Set(pending.exportedNames);
  const removed = before.filter((name) => !name.includes('.') && !after.has(name));
  if (removed.length === 0) return undefined;

  // The developer named this file, so its shape is theirs to change.
  if (taskNamed(intent.file, deps.neighborhood.task)) return undefined;

  const dependents = await dependentsOf(removed, deps);
  if (dependents.total === 0) return undefined;

  const list = removed.slice(0, 3).join(', ');
  return {
    decision: 'SUSPICIOUS',
    reason:
      `${intent.file} stops exporting ${list}, and ${dependents.total} place` +
      `${dependents.total === 1 ? '' : 's'} in the codebase call ` +
      `${removed.length === 1 ? 'it' : 'them'}. The task never named this file.`,
    evidence: [
      { kind: 'note', text: `no longer exported: ${removed.join(', ')}` },
      { kind: 'path', text: `called from ${dependents.examples.join(', ')}` },
    ],
    question:
      `"${deps.neighborhood.task}" does not mention ${intent.file}. ` +
      `Removing ${list} changes what ${dependents.total} other place` +
      `${dependents.total === 1 ? '' : 's'} depend on — is that part of this task?`,
    needsJudge: true,
  };
}

/** Did the task text name this file outright? */
function taskNamed(file: string, task: string): boolean {
  const lower = file.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  // Reuses the prompt reader, so "which files did the developer name" has one
  // answer across the codebase rather than two that drift.
  return namedTokens(task).paths.some((p) => lower.endsWith(p) || p === base);
}

/**
 * How many places call these names, and a few of them by file.
 *
 * The count is the whole argument — "232 places import this" is what makes the
 * difference between a refactor and a hazard legible — so it is never estimated.
 */
async function dependentsOf(
  names: string[],
  deps: ClassifyDeps,
): Promise<{ total: number; examples: string[] }> {
  const files = new Set<string>();
  let total = 0;

  for (const name of names.slice(0, 4)) {
    const rows = await deps.client.run(
      `MATCH (caller:Function {repo: $repo})-[:CALLS]->(target:Function {repo: $repo, name: $name})
         RETURN caller.file AS file`,
      { repo: deps.repo, name },
    );
    total += rows.records.length;
    for (const record of rows.records.slice(0, 40)) files.add(String(record.get('file')));
  }

  return { total, examples: [...files].slice(0, 3) };
}

/**
 * A verdict for an edit to a Prisma schema.
 *
 * The schema is where the data the task works on is actually declared, so the
 * question is simply whether those models are the task's. `coreModels` is the
 * boundary's own answer to "what data is this task about", already computed and
 * already what the rest of the classifier uses.
 *
 * Returns undefined if the schema is not in the graph — a schema file added in
 * this very turn, most likely — so the caller falls through to the general
 * unreadable-file path rather than asserting anything.
 */
async function prismaSchemaEdit(
  file: string,
  deps: ClassifyDeps,
): Promise<Verdict | undefined> {
  const fileId = await fileNodeId(file, deps);
  if (fileId === undefined) return undefined;

  const rows = await deps.client.run(
    `MATCH (f:File {id: $id})-[:DECLARES]->(m:Model) RETURN m.name AS name`,
    { id: gInt(fileId) },
  );
  const declared = rows.records.map((r) => String(r.get('name')));
  if (declared.length === 0) return undefined;

  const core = declared.filter((name) => deps.neighborhood.coreModels.has(name));
  if (core.length > 0) {
    return {
      decision: 'EXPECTED',
      reason: `${file} declares ${core.join(', ')}, which is the data this task is about.`,
      evidence: [{ kind: 'model', text: `declares ${core.join(', ')}` }],
      needsJudge: false,
    };
  }

  // Declares models, none of them the task's. Worth saying — a schema change is
  // a change to shared shape — but Ichor has not read a line of the diff, so it
  // reports rather than challenges.
  return {
    decision: 'NOT_JUDGED',
    reason:
      `${file} declares ${declared.slice(0, 4).join(', ')}, and this task is about ` +
      `${[...deps.neighborhood.coreModels].slice(0, 3).join(', ') || 'no particular model'}.`,
    evidence: [
      { kind: 'model', text: `declares ${declared.slice(0, 6).join(', ')}` },
      { kind: 'note', text: 'a schema edit is reported, not challenged — Ichor does not read the diff' },
    ],
    needsJudge: false,
  };
}

/**
 * A verdict for a file Ichor has not parsed.
 *
 * THREE STEPS, IN ORDER, and the last one is the important one.
 *
 *   1  Is it in the graph anyway? A `.prisma` schema is, and so is any asset a
 *      TypeScript file imports. Then the normal logic applies and this returns
 *      undefined to let it run.
 *   2  Does its PATH match what the task is about? `locales/en/viewer.json` in a
 *      task about the viewer's expired-link message is not a coincidence, and the
 *      same scorer that draws the boundary can say so.
 *   3  Otherwise say nothing. NOT a challenge.
 *
 * Step 3 is the fix for the worst false-alarm class Ichor had. Every JSON, CSS,
 * Markdown and config edit was SUSPICIOUS, because everything absent from the
 * graph was — including `locales/en/viewer.json` during a task about changing
 * exactly that message. Ichor had not read the file, could not have read it, and
 * challenged it for scope expansion regardless (rule: never assert more than the
 * evidence supports).
 */
async function unreadableFile(
  intent: ChangeIntent,
  deps: ClassifyDeps,
): Promise<Verdict | undefined> {
  // In the graph despite not being parsed — a Prisma schema, or an imported
  // asset. There is real structure to reason about, so fall through.
  if ((await fileNodeId(intent.file, deps)) !== undefined) return undefined;

  const matched = pathMatchesTask(intent.file, deps.neighborhood);
  if (matched.length > 0) {
    return {
      decision: 'CONNECTED',
      reason:
        `${intent.file} is not code Ichor reads, but its path matches the task ` +
        `(${matched.join(', ')}).`,
      evidence: [{ kind: 'note', text: `path matches: ${matched.join(', ')}` }],
      needsJudge: false,
    };
  }

  return {
    decision: 'NOT_JUDGED',
    reason: `${intent.file} is not a file Ichor reads, so it has no view on this change.`,
    evidence: [
      { kind: 'note', text: 'not TypeScript or a Prisma schema — nothing in the graph describes it' },
    ],
    needsJudge: false,
  };
}

/**
 * Words shared between a file's path and the task's own terms.
 *
 * Deliberately the task's TERMS rather than raw prompt words: those are already
 * split, stemmed and stop-worded by the anchor scorer, so "viewers" in the prompt
 * matches `viewer.json` on disk. Segments shorter than four characters are
 * skipped — `en`, `api` and `lib` appear in half the paths in any repository and
 * would make this match everything.
 */
function pathMatchesTask(file: string, neighborhood: Neighborhood): string[] {
  const segments = new Set(
    file
      .toLowerCase()
      .split(/[\/\\._-]+/)
      .filter((s) => s.length >= 4),
  );
  if (segments.size === 0) return [];

  const hits: string[] = [];
  for (const term of neighborhood.terms ?? []) {
    const t = term.toLowerCase();
    if (t.length < 4) continue;
    for (const segment of segments) {
      // Either direction: "expiration" in the path matches the term "expire",
      // and "viewer" matches "viewers".
      if (segment === t || segment.startsWith(t) || t.startsWith(segment)) {
        hits.push(term);
        break;
      }
    }
  }
  return [...new Set(hits)].slice(0, 4);
}

/**
 * A file that exists in the codebase but sits entirely outside the task.
 *
 * Returns undefined when the file is not in the graph at all, so the caller can
 * fall through to the new-file logic.
 */
async function existingFileOutsideTask(
  file: string,
  deps: ClassifyDeps,
): Promise<Verdict | undefined> {
  // Two steps — see fileNodeId. The single-query form cost 30 seconds for a file
  // that is not in the graph, which is every new file an agent writes.
  const fileId = await fileNodeId(file, deps);
  if (fileId === undefined) return undefined; // not in the graph — a new file

  const declared = await declaredIn(fileId, deps);
  if (declared.length === 0) return undefined;

  const functionIds = declared.map((d) => d.id);
  const names = declared.map((d) => d.name);

  /**
   * Give an existing file the same hearing a new one gets.
   *
   * This branch used to challenge any file with no member in it, full stop. But
   * the boundary is a few hundred functions out of several thousand, so "no
   * member here" describes almost every file a real task touches — and a NEW
   * file was treated more generously than an existing one, which is backwards.
   *
   * Measured against 30 real commits, this single branch produced 50 of the 51
   * challenges Ichor would have raised against work a developer genuinely had to
   * do. One hop is the honest test: if code here calls, or is called by, the
   * task's own code, it is connected, and connected is not suspicious.
   */
  const link = await oneHopFromTask(functionIds, deps);
  if (link) {
    return {
      decision: 'CONNECTED',
      reason: `${file} is not part of the task, but ${link.from} ${link.direction} ${link.to}, which is.`,
      evidence: [
        { kind: 'note', text: `declares ${names.slice(0, 4).join(', ')}` },
        { kind: 'member', text: `${link.from} ${link.direction} ${link.to}` },
      ],
      needsJudge: false,
    };
  }

  const overlap = await modelOverlap(deps, functionIds);

  const evidence: Evidence[] = [
    { kind: 'note', text: `declares ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` (+${names.length - 4})` : ''}` },
    { kind: 'note', text: 'no function in this file is reachable from the task' },
  ];
  if (overlap.foreign.length) {
    evidence.push({ kind: 'model', text: `works on ${overlap.foreign.join(', ')}` });
  }

  return {
    decision: 'SUSPICIOUS',
    reason:
      `${file} exists in the codebase but nothing in it is reachable from the task` +
      (overlap.foreign.length ? `, and it works on ${overlap.foreign.join(', ')}` : '') +
      '.',
    evidence,
    question: `Why does "${deps.neighborhood.task}" require a change in ${file}?`,
    needsJudge: true,
  };
}

/**
 * The functions a file declares — found in two steps, deliberately.
 *
 * `MATCH (f:File {repo})-[:DECLARES]->(fn:Function) WHERE f.path = $path`
 * expands EVERY file's declarations before filtering by path. Measured on a
 * 1,362-file repo: 10 seconds for a file that exists, and **30 seconds — the
 * engine's query limit — for one that does not**, which is every new file an
 * agent creates. With retries that became 158 seconds and the hook was killed.
 *
 * Matching the File node by itself is fast in both cases (19ms found, 124ms
 * missing), so ask that first and only expand once there is something to expand
 * from. Same answer, roughly a hundred times faster.
 */
async function fileNodeId(file: string, deps: ClassifyDeps): Promise<number | undefined> {
  const rows = await deps.client.run(
    `MATCH (f:File {repo: $repo, path: $path}) RETURN f.id AS id LIMIT 1`,
    { path: file, repo: deps.repo },
  );
  return rows.records.length ? Number(rows.records[0].get('id')) : undefined;
}

async function declaredIn(
  fileId: number,
  deps: ClassifyDeps,
): Promise<{ id: number; name: string }[]> {
  const rows = await deps.client.run(
    `MATCH (f:File {id: $id})-[:DECLARES]->(fn:Function)
       RETURN fn.id AS id, fn.name AS name`,
    { id: gInt(fileId) },
  );
  return rows.records.map((r) => ({ id: Number(r.get('id')), name: String(r.get('name')) }));
}

/** Graph ids of every function a file declares. */
async function functionsDeclaredIn(file: string, deps: ClassifyDeps): Promise<number[]> {
  const fileId = await fileNodeId(file, deps);
  if (fileId === undefined) return [];
  return (await declaredIn(fileId, deps)).map((f) => f.id);
}

/**
 * Does any of these functions sit one call away from the task's own code?
 *
 * Stops at the first link found — one concrete connection is enough to answer
 * the question, and the citation is what the developer actually reads.
 */
async function oneHopFromTask(
  functionIds: number[],
  deps: ClassifyDeps,
): Promise<{ from: string; to: string; direction: string } | undefined> {
  const members = new Map(
    [...deps.neighborhood.members.values()].map((m) => [m.id, m.name]),
  );
  if (members.size === 0) return undefined;

  for (const id of functionIds) {
    const calls = await deps.client.run(
      `MATCH (a:Function {id: $id})-[:CALLS]->(b:Function)
         RETURN a.name AS from, b.id AS id, b.name AS to`,
      { id: gInt(id) },
    );
    for (const record of calls.records) {
      if (members.has(Number(record.get('id')))) {
        return { from: String(record.get('from')), to: String(record.get('to')), direction: 'calls' };
      }
    }

    const callers = await deps.client.run(
      `MATCH (b:Function)-[:CALLS]->(a:Function {id: $id})
         RETURN a.name AS from, b.id AS id, b.name AS to`,
      { id: gInt(id) },
    );
    for (const record of callers.records) {
      if (members.has(Number(record.get('id')))) {
        return { from: String(record.get('from')), to: String(record.get('to')), direction: 'is called by' };
      }
    }
  }
  return undefined;
}

/** Models touched by a set of functions, split by whether the TASK is about them. */
async function modelOverlap(
  deps: ClassifyDeps,
  functionIds: number[],
): Promise<{ shared: string[]; foreign: string[] }> {
  const taskModels = deps.neighborhood.coreModels;
  const shared = new Set<string>();
  const foreign = new Set<string>();

  for (const id of functionIds) {
    const rows = await deps.client.run(
      `MATCH (f:Function {id: $id})-[:TOUCHES]->(m:Model) RETURN m.name AS name`,
      { id: gInt(id) },
    );
    for (const record of rows.records) {
      const name = String(record.get('name'));
      (taskModels.has(name) ? shared : foreign).add(name);
    }
  }

  // A model in both sets is shared — presence in the task wins.
  for (const name of shared) foreign.delete(name);
  return { shared: [...shared], foreign: [...foreign] };
}

/** TEST 1: does the pending file reach the task neighbourhood? */
function reachIntoNeighborhood(
  pending: PendingFacts,
  neighborhood: Neighborhood,
): { connected: boolean; summary: string; evidence: Evidence[] } {
  const memberNames = new Set([...neighborhood.members.values()].map((m) => m.name));
  const memberFiles = new Set([...neighborhood.members.values()].map((m) => m.file));
  const taskModels = new Set([...neighborhood.models.values()].map((m) => m.name));
  const evidence: Evidence[] = [];

  const calledMembers = pending.callsNames.filter((n) => memberNames.has(n));
  const importedMembers = pending.importsRepoFiles.filter((f) =>
    [...memberFiles].some((mf) => mf.replace(/\.(ts|tsx)$/, '') === f),
  );
  const sharedModels = pending.touches
    .map((t) => t.model)
    .filter((m) => [...taskModels].some((tm) => tm.toLowerCase() === m.toLowerCase()));

  if (calledMembers.length) evidence.push({ kind: 'path', text: `calls ${calledMembers.join(', ')}` });
  if (importedMembers.length) evidence.push({ kind: 'path', text: `imports ${importedMembers.join(', ')}` });
  if (sharedModels.length) evidence.push({ kind: 'model', text: `touches ${[...new Set(sharedModels)].join(', ')}` });

  const parts = [
    calledMembers.length ? `calls ${calledMembers.length} function(s) in scope` : '',
    importedMembers.length ? `imports ${importedMembers.length} file(s) in scope` : '',
    sharedModels.length ? `touches ${[...new Set(sharedModels)].join(', ')}` : '',
  ].filter(Boolean);

  return {
    connected: parts.length > 0,
    summary: parts.join('; '),
    evidence,
  };
}

interface DuplicateFlow {
  /** route / entry point */
  newFlowKind: string;
  model: string;
  existingEntry: string;
  existingPath: string;
  constraintNote: string;
  /** Set when the new route reaches the model through a file it imports. */
  viaFile?: string;
}

/** A model the pending file reaches, and whether it does so directly. */
interface PendingReach {
  model: string;
  viaFile?: string;
}

/** HTTP methods that change data, and so are where a constraint gets enforced. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * TEST 2 — the new-flow test.
 *
 * Fires when the pending file introduces a NEW ENTRY POINT (an HTTP route)
 * reaching a model that the task's existing path already reaches. That is the
 * shape of "you built a second door to a room that already had one".
 *
 * Deliberately narrow. A broad version would challenge every new helper that
 * happens to read a model the task also reads, which is most legitimate work.
 */
async function findDuplicateFlow(
  pending: PendingFacts,
  deps: ClassifyDeps,
): Promise<DuplicateFlow | undefined> {
  if (pending.routeMethods.length === 0) return undefined; // not a new entry point

  const { neighborhood, client } = deps;

  const reached = await pendingReaches(pending, deps);
  if (reached.length === 0) return undefined; // reaches no data

  for (const touch of reached) {
    const taskModel = [...neighborhood.models.values()].find(
      (m) => m.name.toLowerCase() === touch.model.toLowerCase(),
    );
    if (!taskModel) continue;

    // Find the route in the task neighbourhood that already reaches this model,
    // and the chain that gets there. This is the sentence the agent is shown, so
    // it must come from the graph rather than be asserted.
    //
    // The LIMIT is deliberately far above what a real answer needs: HydraDB
    // truncates silently, and a tight limit would decide which route we cite by
    // row order before the ranking below ever sees the alternatives.
    const rows = await client.run(
      `MATCH (r:Route {repo: $repo})-[:HANDLED_BY]->(h:Function)-[:CALLS*1..4]->(f:Function)-[:TOUCHES]->(m:Model)
         WHERE m.name = $model
         RETURN r.method AS method, r.path AS path, h.name AS handler, f.name AS reacher,
                r.file AS routeFile
         LIMIT 50`,
      { model: taskModel.name, repo: deps.repo },
    );

    const forced = new Set(deps.forced ?? []);
    const candidates = rows.records.filter((record) => {
      const handler = String(record.get('handler'));
      const routeFile = String(record.get('routeFile') ?? '');
      // Never argue from code the agent forced past a challenge.
      if (forced.has(routeFile)) return false;
      return [...neighborhood.members.values()].some((m) => m.name === handler);
    });
    if (candidates.length === 0) continue;

    // If the model has a unique constraint on a field the task named, say so —
    // it is usually the whole reason the extra endpoint is unnecessary. Fetched
    // BEFORE the ranking, because it changes which route argues best.
    const uniqueRows = await client.run(
      `MATCH (m:Model {repo: $repo})-[:HAS_FIELD]->(f:Field)
         WHERE m.name = $model AND f.isUnique = true
         RETURN f.name AS name LIMIT 3`,
      { model: taskModel.name, repo: deps.repo },
    );
    const uniqueFields = uniqueRows.records
      .map((r) => String(r.get('name')))
      .filter((name) => neighborhood.terms.some((t) => name.toLowerCase().includes(t)));

    // Several existing routes reach the same model and the row order is the
    // database's, not ours — so pick the one that makes the strongest argument.
    //
    // Which route that is depends on what we are arguing:
    //
    //   With a unique constraint, the claim is "this rule is ALREADY ENFORCED",
    //   and enforcement happens where the data is written. Citing a read route
    //   invites the obvious rebuttal, and a real Claude Code run gave exactly
    //   that one: told its new check-email endpoint duplicated GET /api/vendors,
    //   it answered that listing every vendor to ask about one address would be
    //   worse — and it was right. The route to cite was POST /api/vendors, which
    //   enforces the constraint and already answers with a 409.
    //
    //   Without a constraint, the claim is "this door already exists", and the
    //   closest analogue is a route using the same method as the pending file.
    //
    // The path/handler tie-break keeps the message identical run to run.
    const wantsMethod = new Set(pending.routeMethods.map((m) => m.toUpperCase()));
    const argueFromEnforcement = uniqueFields.length > 0;

    const rank = (record: (typeof candidates)[number]): number => {
      const method = String(record.get('method')).toUpperCase();
      if (argueFromEnforcement) return MUTATING_METHODS.has(method) ? 0 : 1;
      return wantsMethod.has(method) ? 0 : 1;
    };

    const inScope = candidates.sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      const byPath = String(a.get('path')).localeCompare(String(b.get('path')));
      if (byPath !== 0) return byPath;
      return String(a.get('handler')).localeCompare(String(b.get('handler')));
    })[0];

    const method = String(inScope.get('method'));
    const routePath = String(inScope.get('path'));
    const handler = String(inScope.get('handler'));
    const reacher = String(inScope.get('reacher'));

    return {
      newFlowKind: `${pending.routeMethods.join('/')} endpoint at ${pending.routePath}`,
      model: taskModel.name,
      existingEntry: `${method} ${routePath}`,
      existingPath: `${method} ${routePath} → ${handler} → ${reacher} → ${taskModel.name}`,
      // Says WHEN the constraint bites, not just that it exists.
      //
      // "Vendor.email is already unique" reads as "duplicate handling is already
      // covered", and the Judge then refuses even a claim it cannot check — like
      // an agent arguing it needs feedback BEFORE submit. A unique constraint on
      // a write path is enforced at write time, and saying so leaves room for a
      // requirement about a different moment to be judged on its merits.
      constraintNote: uniqueFields.length
        ? `, where ${taskModel.name}.${uniqueFields[0]} is unique and a duplicate is rejected at ${
            MUTATING_METHODS.has(method.toUpperCase()) ? 'write time' : 'request time'
          }`
        : '',
      viaFile: touch.viaFile,
    };
  }

  return undefined;
}

/**
 * What data does the pending file reach?
 *
 * Prisma calls written directly in the file are the easy case. The case that
 * matters is the polite one: an agent that adds a helper to an existing service
 * and calls THAT from its new route touches no database client at all, so the
 * literal parse sees nothing and a new entry point walks straight through.
 * A real Claude Code run did exactly this — it added `isVendorEmailTaken` to
 * the vendor service, then wrote a route that only called it.
 *
 * So when the file touches nothing directly, ask the graph what the files it
 * imports already reach. The new helper itself is not in the graph — it was
 * written seconds ago — but the file it was added to is, and that is enough.
 */
async function pendingReaches(
  pending: PendingFacts,
  deps: ClassifyDeps,
): Promise<PendingReach[]> {
  if (pending.touches.length > 0) {
    return pending.touches.map((touch) => ({ model: touch.model }));
  }

  const found: PendingReach[] = [];
  const seen = new Set<string>();

  for (const imported of pending.importsRepoFiles) {
    // parsePending strips the extension; the graph stores the real filename.
    const candidates = [`${imported}.ts`, `${imported}.tsx`, `${imported}/index.ts`];

    const rows = await deps.client.run(
      `MATCH (f:File {repo: $repo})-[:DECLARES]->(fn:Function)-[:TOUCHES]->(m:Model)
         WHERE f.path = $a OR f.path = $b OR f.path = $c
         RETURN m.name AS model, f.path AS file
         LIMIT 50`,
      { a: candidates[0], b: candidates[1], c: candidates[2], repo: deps.repo },
    );

    for (const record of rows.records) {
      const model = String(record.get('model'));
      if (seen.has(model)) continue;
      seen.add(model);
      found.push({ model, viaFile: String(record.get('file')) });
    }
  }

  return found;
}
