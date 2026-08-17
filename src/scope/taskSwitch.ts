/**
 * Noticing that the developer has moved on to a different job.
 *
 * A boundary drawn at 9am is meaningless by 2pm. Nobody re-runs a CLI command
 * between tasks — they just keep typing in the same conversation. So when a new
 * prompt arrives we ask one question: does it point at the part of the codebase
 * we are currently watching, or somewhere else entirely?
 *
 * Everything here is PURE — no graph, no ts-morph, no I/O. That is deliberate:
 * this runs inline on the developer's keystroke, inside a hook that must never
 * make them wait, and it is the piece most likely to be wrong, so it has to be
 * testable without Docker running.
 *
 * The matching rule is imported from anchors.ts rather than rewritten. The
 * detector and the thing that drew the boundary must agree exactly.
 */

import { matches, taskTerms, type AnchorKind } from './anchors.js';
import { namedTokens } from './named.js';
import type { GraphFacts } from '../extract/types.js';

/**
 * Structural path words. They appear in every repo and name no part of one, so
 * a prompt mentioning a file path does not light up the entire index.
 *
 * Kept as an explicit list rather than a "term matches too many entries"
 * heuristic: on a small codebase a genuinely meaningful word like `vendor`
 * legitimately matches most of it, and an adaptive cap would throw it away.
 */
const STRUCTURAL = new Set([
  'src', 'lib', 'app', 'api', 'apps', 'packages', 'components', 'component',
  'utils', 'util', 'helpers', 'helper', 'shared', 'common', 'core', 'index',
  'test', 'tests', 'spec', 'specs', 'types', 'type', 'config', 'route', 'routes',
  'page', 'pages', 'server', 'client', 'server.ts', 'tsx', 'jsx',
]);

/**
 * Terms considered from one prompt.
 *
 * A pasted stack trace or a wall of logs would otherwise dominate the signal.
 * The first 40 meaningful terms are plenty to name a task.
 */
const MAX_TERMS = 40;

/**
 * How scattered the outside matches may be before we distrust them.
 *
 * A prompt naming one new area hits a handful of files in that area. Something
 * hitting a dozen unrelated files is noise, and acting on noise means redrawing
 * the boundary for no reason. Precision over recall (rule 1a).
 */
const MAX_OUTSIDE_SPREAD = 8;

/**
 * WHY THERE IS NO ADAPTIVE VERSION OF THE LIST ABOVE.
 *
 * A fixed list only knows the words someone thought of. Measured on Infisical
 * (7,741 files, 37,672 index entries), an ordinary prompt produced terms reaching
 * `backend` 54.4%, `services` 41.6%, `one` 28.2% and `secret` 25.4% of the index —
 * none of which are on that list, and the first two of which are structural for
 * that repo alone.
 *
 * So dropping any term that matches more than ~15% of the index looks obvious, and
 * it was built and then discarded. On the eleven-file fixture the same rule throws
 * away `invoice` — a word matching 8 of 47 entries because the fixture IS about
 * billing — and two tests caught it immediately. The share of a codebase a
 * meaningful word covers depends entirely on the size of the codebase, and one
 * repository is not enough to calibrate a threshold that has to hold for both.
 *
 * The live failure it was meant to fix is fixed below instead, by a signal that
 * needs no threshold: a path the developer typed. `ground-truth.ts` measures switch
 * detection, so the adaptive version can be justified with numbers when there are
 * numbers, rather than tuned against a single repo.
 */

/**
 * How many paths a prompt may name before it looks pasted rather than written.
 *
 * A developer names one file, occasionally two. A stack trace names ten. That
 * difference is the whole reason a named path is allowed past the spread guard
 * below — "one file named is a statement, ten is a paste".
 */
const MAX_NAMED_PATHS = 3;

export interface IndexEntry {
  /** Display name, e.g. `createVendor`, `POST /api/vendors`, `Vendor`. */
  name: string;
  kind: AnchorKind;
  /** Repo-relative, absent for models and fields. */
  file?: string;
}

export interface NameIndex {
  version: 1;
  builtAt: string;
  entries: IndexEntry[];
}

/** What the boundary currently covers. Derived from the persisted task. */
export interface BoundaryView {
  names: string[];
  files: string[];
}

export type PromptVerdict = 'NO_SIGNAL' | 'SAME' | 'WIDENED' | 'NEW';

export interface PromptClassification {
  verdict: PromptVerdict;
  terms: string[];
  /** Terms that landed inside the current boundary. */
  insideHits: string[];
  /** Terms that landed only outside it. */
  outsideHits: string[];
  /** Distinct files the outside hits touched — the spread guard. */
  outsideFiles: string[];
  /**
   * Things the prompt named OUTRIGHT that are not in the boundary.
   *
   * A path or an identifier written out in full is not a fuzzy word match, and it
   * does not get averaged in with one. See `namedTokens`.
   */
  namedOutside: string[];
  /** One line for hook.log. Every verdict must be explainable. */
  reason: string;
}

/**
 * Every name in the repo, flattened for substring matching.
 *
 * Built from GraphFacts at refresh time and cached on disk, so classifying a
 * prompt costs one file read and no analysis.
 */
export function buildNameIndex(facts: GraphFacts, builtAt: string): NameIndex {
  const entries: IndexEntry[] = [];

  for (const fn of facts.functions) {
    entries.push({ name: fn.name, kind: 'function', file: fn.file });
  }
  for (const route of facts.routes) {
    entries.push({ name: `${route.method} ${route.path}`, kind: 'route', file: route.file });
  }
  for (const model of facts.models) {
    entries.push({ name: model.name, kind: 'model' });
  }
  // Types matter here for the same reason they matter as anchors: in an app with
  // no Prisma schema, "now switch to the Invoice type" names nothing otherwise.
  for (const type of facts.types) {
    entries.push({ name: type.name, kind: 'type', file: type.file });
  }
  for (const field of facts.fields) {
    entries.push({ name: `${field.model}.${field.name}`, kind: 'field' });
  }
  // Files earn an entry of their own: "fix src/lib/billing/invoice.ts" names a
  // place without naming a single symbol in it.
  for (const file of facts.files) {
    entries.push({ name: file.path, kind: 'file', file: file.path });
  }

  return { version: 1, builtAt, entries };
}

/**
 * Where an entry lives, for the purpose of "how scattered is this?".
 *
 * A model and all of its fields are ONE place. Counting `Invoice.id`,
 * `Invoice.amount`, `Invoice.paid` and the rest separately made a single table
 * look like seven unrelated locations, which tripped the spread guard and made
 * "fix the billing invoice rounding" read as noise instead of a task switch.
 */
function locationOf(entry: IndexEntry): string {
  if (entry.file) return entry.file;
  if (entry.kind === 'field') return `model:${entry.name.split('.')[0]}`;
  return `model:${entry.name}`;
}

/** Does this entry sit inside the boundary we are currently watching? */
function isInside(entry: IndexEntry, boundary: BoundaryView): boolean {
  if (boundary.names.some((n) => n.toLowerCase() === entry.name.toLowerCase())) return true;
  if (entry.file && boundary.files.some((f) => f === entry.file)) return true;
  return false;
}

/**
 * Same job, wider job, different job, or no signal at all.
 *
 * The safe answer is always NO_SIGNAL: it changes nothing. Every ambiguous case
 * below resolves that way rather than moving a boundary on a guess.
 */
export function classifyPrompt(
  prompt: string,
  index: NameIndex,
  boundary: BoundaryView,
): PromptClassification {
  const all = taskTerms(prompt).filter((t) => !STRUCTURAL.has(t));
  const terms = all.slice(0, MAX_TERMS);

  const insideHits: string[] = [];
  const outsideHits: string[] = [];
  const outsideFiles = new Set<string>();

  for (const term of terms) {
    let insideCount = 0;
    const filesForTerm: string[] = [];

    for (const entry of index.entries) {
      if (!matches(term, entry.name) && !(entry.file && matches(term, entry.file))) continue;
      if (isInside(entry, boundary)) insideCount++;
      else filesForTerm.push(locationOf(entry));
    }

    /**
     * Compare the two sides. Do not stop at the first inside hit.
     *
     * This loop used to `break` the moment one matching entry was inside the
     * boundary, which made a term "inside" however much stronger the outside
     * evidence was. On the prompt *"also refactor lib/utils.ts: extract the cn
     * helper"* the generic word "file" matched one in-scope symbol and the whole
     * prompt read as SAME, so a refactor of a helper used in 232 places was
     * judged against a task about message wording.
     *
     * A term counts as inside only when the boundary holds at least as many
     * matches as the rest of the repo. Anything else is a term pointing
     * elsewhere, and it is recorded as such.
     */
    if (insideCount > 0 && insideCount >= filesForTerm.length) {
      insideHits.push(term);
      continue;
    }
    if (filesForTerm.length > 0) {
      outsideHits.push(term);
      for (const f of filesForTerm) outsideFiles.add(f);
      continue;
    }
    if (insideCount > 0) insideHits.push(term);
  }

  /**
   * Things the prompt named outright and the boundary does not hold.
   *
   * Checked against the index directly, not through `matches`: an exact path or
   * an exact symbol name is not a fuzzy match and must not be diluted by one.
   */
  const named = namedTokens(prompt);
  const namedOutside: string[] = [];

  for (const p of named.paths) {
    const known = index.entries.some((e) => e.file?.toLowerCase().endsWith(p));
    const inBoundary = boundary.files.some((f) => f.toLowerCase().endsWith(p));
    if (inBoundary) continue;
    // A path the repo does not have yet is still a statement of intent — `lib/cn.ts`
    // in "extract cn into its own file" names where the developer is going.
    if (known || /\.(tsx?|jsx?|prisma|json|css)$/.test(p)) namedOutside.push(p);
  }

  for (const id of named.identifiers) {
    const lower = id.toLowerCase();
    if (boundary.names.some((n) => n.toLowerCase() === lower)) continue;
    // Only if the repo actually has it. An invented name is not evidence.
    if (index.entries.some((e) => e.name.toLowerCase() === lower)) namedOutside.push(id);
  }

  const spread = [...outsideFiles];
  const base = { terms, insideHits, outsideHits, outsideFiles: spread, namedOutside };

  /**
   * A handful of named paths survives the spread guard. A wall of them does not.
   *
   * This distinction was stated in the comment here and then not made in the code:
   * named paths were simply added to the fuzzy spread, so a prompt naming ONE file
   * was thrown away because unrelated words in the same sentence happened to match
   * thousands. On a live session that lost every explicit instruction —
   * *"in backend/src/.../pki-subscriber-queue.ts set attempts: 3"* was filed as
   * scattered noise across 6,453 files.
   *
   * A developer names one file. A stack trace names ten. So the count of named paths
   * decides which of the two this is, and the fuzzy spread is judged separately.
   */
  const namedPaths = namedOutside.filter((t) => t.includes('/') || /\.\w+$/.test(t));
  const pasted = namedPaths.length > MAX_NAMED_PATHS;

  if (pasted || namedPaths.length === 0) {
    const places = new Set([...spread, ...namedPaths]);
    if (places.size > MAX_OUTSIDE_SPREAD) {
      return {
        ...base,
        verdict: 'NO_SIGNAL',
        reason: `outside matches too scattered (${places.size} files) to be a task`,
      };
    }
  }

  /**
   * A path or symbol written out in full decides this on its own.
   *
   * Ahead of the word counts, because it is a different KIND of evidence: fuzzy
   * overlap is a guess about what a prompt is about, and `lib/utils.ts` is the
   * developer stating it. Something named outright and absent from the boundary
   * means the boundary has to move, whatever the generic words say.
   */
  if (namedOutside.length > 0 && !pasted) {
    const alsoInside = insideHits.length > 0 || boundary.names.length === 0;
    return {
      ...base,
      verdict: alsoInside ? 'WIDENED' : 'NEW',
      reason:
        `names ${namedOutside.slice(0, 3).join(', ')} outright, which the boundary does not cover` +
        (insideHits.length ? ` (still inside: ${insideHits.slice(0, 3).join(', ')})` : ''),
    };
  }

  if (terms.length === 0) {
    return { ...base, verdict: 'NO_SIGNAL', reason: 'prompt names nothing in the codebase' };
  }
  if (insideHits.length === 0 && outsideHits.length === 0) {
    return { ...base, verdict: 'NO_SIGNAL', reason: 'no term matched any known symbol' };
  }
  if (outsideHits.length === 0) {
    return { ...base, verdict: 'SAME', reason: `stays inside the boundary (${insideHits.join(', ')})` };
  }
  if (insideHits.length === 0) {
    return { ...base, verdict: 'NEW', reason: `points only outside the boundary (${outsideHits.join(', ')})` };
  }
  return {
    ...base,
    verdict: 'WIDENED',
    reason: `inside (${insideHits.join(', ')}) plus new ground (${outsideHits.join(', ')})`,
  };
}

/**
 * Is this prompt a question rather than an instruction?
 *
 * *"Where is link expiry enforced?"* set a 374-function boundary on papermark. A
 * question changes nothing about the codebase, so a boundary drawn from one has
 * nothing to protect — and it lingers, so the next real edit is judged against a
 * task the developer never set.
 *
 * Deliberately narrow. The test is an interrogative opening or a trailing `?` with
 * no imperative in sight, because the expensive mistake is the other direction:
 * treating "can you fix the expiry check?" as idle curiosity would leave Ichor
 * silent through the whole change. A polite request is an instruction.
 */
export function isQuestion(prompt: string): boolean {
  const text = prompt.trim();
  if (text.length === 0) return false;

  /**
   * Politeness wrapped around an instruction. Checked FIRST, because every one of
   * these opens with an interrogative word: *"could you fix the crash?"* is work,
   * and reading it as idle curiosity would leave Ichor silent through the change.
   */
  const REQUEST = /^\s*(please\b|(can|could|would|will|why\s+don'?t|how\s+about)\s+(you|we|i)\b)/i;
  if (REQUEST.test(text)) return false;

  /**
   * A wh- opening asks, whatever verbs turn up later.
   *
   * This is why an "imperative anywhere" test does not work: *"where is duplicate
   * email handling in this codebase"* contains `handling`, and treating that as a
   * command made a plain question look like a task.
   */
  if (/^\s*(where|what|which|who|whom|whose|when|why|how)\b/i.test(text)) return true;

  // `is there` / `are there` — the one yes/no frame that cannot be an instruction.
  if (/^\s*(is|are|was|were)\s+(there|any)\b/i.test(text)) return true;

  /**
   * A trailing `?` with no instruction in it.
   *
   * Deliberately the narrowest branch. Everything else falls through to "this is
   * work", because the two mistakes cost very different amounts: reading a
   * question as a task draws a boundary that was going to be drawn anyway, while
   * reading a task as a question turns Ichor off for the whole job.
   */
  const IMPERATIVE =
    /\b(add|fix|chang|updat|refactor|renam|remov|delet|implement|creat|writ|mak|mov|extract|replac|migrat|revert|wir|support|improv|clean|split|merg|introduc|build|switch)(e|es|ed|ing|s)?\b/i;
  if (/\?\s*$/.test(text) && !IMPERATIVE.test(text)) return true;

  return false;
}
