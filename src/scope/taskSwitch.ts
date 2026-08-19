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
 * How few places a term must land in to count as pointing at something.
 *
 * A word matching three files is telling you where the work is. A word matching
 * a hundred and thirty-five is telling you it is an English word. The spread
 * guard above judges a whole prompt; this judges one term, which is the unit
 * that actually carries the signal.
 *
 * Deliberately the same number as MAX_OUTSIDE_SPREAD rather than a second tuned
 * constant: "few enough places to be a task" is the same question asked of one
 * word instead of all of them, and two numbers that mean the same thing drift.
 */
const FOCUSED_TERM_PLACES = MAX_OUTSIDE_SPREAD;

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
 * How many things a prompt may name before it looks pasted rather than written.
 *
 * A developer names one file or one function, occasionally two. A stack trace
 * names ten. That difference is the whole reason something named outright is
 * allowed past the spread guard — "one thing named is a statement, ten is a paste".
 *
 * Counts PATHS AND IDENTIFIERS TOGETHER. It used to count paths alone, which made
 * the guard unreachable for a named symbol and, worse, made the override below
 * unreachable too: `namedPaths.length === 0` sent every identifier-only prompt
 * into the noise guard, where prose always loses. A backticked function name that
 * exists in the index is the developer stating where they are working, exactly as
 * a path is, and is treated the same way now.
 */
const MAX_NAMED_TOKENS = 3;

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
  /**
   * What the boundary is ABOUT, as opposed to what it merely reached.
   *
   * Anchors and distance-0 members — the places the task text pointed at
   * directly. Everything else in `files` arrived by walking the call graph.
   *
   * The distinction only matters for something the developer NAMED, and there it
   * matters completely. A boundary drawn from five words of prose can span a
   * seventh of a repository (462 functions across 130 files was measured), which
   * sweeps in files that have nothing to do with the job. Treating "we reached
   * this by traversal" as "the developer is already working here" then made
   * naming that file a no-op: Ichor answered an explicit *"now work on
   * packages/i18n/src/index.ts"* with NO_SIGNAL, because a boundary about rate
   * limiting had incidentally touched it.
   *
   * Reaching a file is not the same as the job being about it. Optional so an
   * older persisted task still classifies rather than crashing — absent means
   * fall back to `files`, which is the previous behaviour exactly.
   */
  coreFiles?: string[];
  /**
   * The names the boundary is ABOUT — anchors and distance-0 members.
   *
   * Same reasoning as `coreFiles`, for a symbol rather than a path. A helper the
   * walk reached three hops out is not evidence that the developer naming it is
   * carrying on with the same job.
   */
  coreNames?: string[];
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
  /**
   * Terms that name a DIRECTORY the repository actually has, outside the boundary.
   *
   * Weaker evidence than `namedOutside` and treated as such — see `areaSegments`.
   */
  areaHits: string[];
  /** One line for hook.log. Every verdict must be explainable. */
  reason: string;
}

/**
 * Every directory name in the repository, as words.
 *
 * WHY THIS EXISTS.
 *
 * The focused-term rule asks how FEW places a word lands in, and that works when
 * the subject of a sentence is a file or a symbol. It inverts when the subject is
 * a directory. Measured on a 890-file monorepo organised by package:
 *
 *     keymap     126 places   <- the subject of "the keymap parser needs a comment"
 *     parser      34
 *     sequences   32
 *     key        197
 *
 * `keymap` matches the path of every file under `packages/keymap/`, so the word
 * that most precisely names the job is the WIDEST term in the prompt. Nothing
 * cleared the bar, the prompt read as noise, and Ichor went on policing the
 * previous task — the same failure the focused-term rule was written to fix,
 * surviving in a shape it does not cover. Two of five prose phrasings worked on
 * that repository, against six of six on one organised by file.
 *
 * A threshold cannot separate these: `keymap` spans 5 top-level areas and `doc` —
 * genuinely generic — spans 8. Measured on both repositories, no cut-off sits
 * between them that does not also break the other. So this is not a threshold at
 * all: **either the repository has a directory of that name or it does not.** That
 * is the same kind of evidence as a path the developer typed, which is the
 * principle the named-outright override already rests on.
 *
 * Segments are split on `-`, `_` and `.` so `rate-limiter` answers to both "rate"
 * and "limiter", and `audio-stream` to "audio". STRUCTURAL words are filtered out
 * before this is consulted, so `src`, `lib` and `packages` cannot match.
 */
function areaSegments(index: NameIndex): Set<string> {
  const segments = new Set<string>();
  for (const entry of index.entries) {
    if (!entry.file) continue;
    const parts = entry.file.split('/');
    parts.pop(); // the filename is not a directory
    for (const part of parts) {
      for (const word of part.split(/[-_.]/)) {
        if (word.length >= 3) segments.add(word.toLowerCase());
      }
    }
  }
  return segments;
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
 * Is the boundary already about a directory of this name?
 *
 * Without this, a term naming the very area being worked on reads as a move to
 * somewhere else — "the cookie chunking" would "name the cookies directory" and
 * widen into what it is already inside. Checked against the boundary's CORE files
 * for the same reason `isCoreFile` exists: a directory the walk merely passed
 * through is not what the job is about.
 */
function namesBoundaryArea(term: string, boundary: BoundaryView): boolean {
  const core = boundary.coreFiles ?? boundary.files;
  if (core.length === 0) return false;

  const under = core.filter((file) => {
    const parts = file.toLowerCase().split('/');
    parts.pop();
    return parts.some((part) => part.split(/[-_.]/).includes(term));
  }).length;

  /**
   * A MAJORITY, not a single file — and that distinction was found by measurement.
   *
   * `some()` looked right and was far too strong. A task about the edit buffer
   * anchored, among 26 core files, one called
   * `packages/keymap/src/addons/opentui/edit-buffer-bindings.ts` — because it is
   * genuinely about edit buffers. That one incidental file sits under
   * `packages/keymap/`, so "keymap" counted as the boundary's own area and the
   * whole signal was suppressed: the prompt *"different job now, the keymap
   * parser…"* was still filed as noise.
   *
   * One file in twenty-six is not what a job is about. Half of them is.
   */
  return under * 2 >= core.length;
}

/**
 * Is the boundary ABOUT this file, rather than merely touching it?
 *
 * Used only for things the prompt named outright — see `BoundaryView.coreFiles`.
 */
function isCoreFile(file: string, boundary: BoundaryView): boolean {
  const core = boundary.coreFiles ?? boundary.files;
  return core.some((f) => f.toLowerCase().endsWith(file));
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
  /**
   * Outside terms precise enough to be pointing at something.
   *
   * See `FOCUSED_TERM_PLACES`. Collected separately from `outsideHits` because
   * the two answer different questions: `outsideHits` is "which words looked
   * outward", and this is "which of them actually said where".
   */
  const focusedOutside: string[] = [];
  /** Where the focused terms land — the footprint the guard actually judges. */
  const focusedFiles = new Set<string>();
  /**
   * How many places each focused term landed in, so the reason can cite the
   * sharpest ones.
   *
   * A term is focused if it lands in few places, but "few" spans a wide range —
   * and a word that matches two files by accident is not the word that explains a
   * verdict. Observed on a real repo: a correct switch was reported as
   * `new ground (different)`, naming a filler word from "different job now" that
   * happened to be rare, while `registry` — the actual subject — went unmentioned.
   * The verdict was right and the explanation was useless, which for the log that
   * answers "why did Ichor do that" is its own kind of wrong.
   */
  const focusedPlaces = new Map<string, number>();
  /**
   * Terms that name a directory the repository has, and that the boundary is not
   * already about. See `areaSegments`.
   */
  const areaHits: string[] = [];
  const segments = areaSegments(index);

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
      const places = new Set(filesForTerm);
      if (places.size <= FOCUSED_TERM_PLACES) {
        focusedOutside.push(term);
        focusedPlaces.set(term, places.size);
        for (const f of places) focusedFiles.add(f);
      } else if (segments.has(term) && !namesBoundaryArea(term, boundary)) {
        // Too wide to be "focused", but it is the name of a real directory the
        // boundary is not about — the developer naming a place.
        areaHits.push(term);
      }
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
    // Named outright, so the question is whether the job is ABOUT this file — not
    // whether the walk happened to pass through it. See BoundaryView.coreFiles.
    if (isCoreFile(p, boundary)) continue;
    // A path the repo does not have yet is still a statement of intent — `lib/cn.ts`
    // in "extract cn into its own file" names where the developer is going.
    if (known || /\.(tsx?|jsx?|prisma|json|css)$/.test(p)) namedOutside.push(p);
  }

  for (const id of named.identifiers) {
    const lower = id.toLowerCase();
    // As with a named path: reached is not the same as about. See coreNames.
    const core = boundary.coreNames ?? boundary.names;
    if (core.some((n) => n.toLowerCase() === lower)) continue;
    // Only if the repo actually has it. An invented name is not evidence.
    if (index.entries.some((e) => e.name.toLowerCase() === lower)) namedOutside.push(id);
  }

  const spread = [...outsideFiles];
  const base = { terms, insideHits, outsideHits, outsideFiles: spread, namedOutside, areaHits };

  /**
   * A handful of named things survives the spread guard. A wall of them does not.
   *
   * This distinction was stated in the comment here and then made only for PATHS:
   * `namedPaths` filtered `namedOutside` down to tokens containing a slash or an
   * extension, and the guard below exempted only those. A named IDENTIFIER —
   * `pruneMemoryStore`, backticked, present in the index, in exactly the file the
   * developer meant — went into `namedOutside`, never into `namedPaths`, so the
   * count was zero, the guard ran, and the function returned NO_SIGNAL before ever
   * reaching the override twenty lines below that exists to outrank it.
   *
   * Measured live on a 1,340-file repository: five consecutive turns classified
   * NO_SIGNAL, including *"different job now. the rate limiter…"*, after which
   * Ichor challenged the very work the developer had just asked for. Only a full
   * repo-relative path could move the boundary. Six phrasings of one intent, one
   * of which worked.
   *
   * A developer names one thing, occasionally two. A stack trace names ten. That
   * is the distinction the count is for, and it applies to a symbol exactly as it
   * applies to a path — so `pasted` now counts everything the prompt named.
   */
  const pasted = namedOutside.length > MAX_NAMED_TOKENS;

  /**
   * A path or symbol written out in full decides this on its own.
   *
   * AHEAD OF THE SPREAD GUARD, because it is a different KIND of evidence: fuzzy
   * overlap is a guess about what a prompt is about, and `lib/utils.ts` — or
   * `pruneMemoryStore` — is the developer stating it. Ordinary English words in a
   * large codebase match hundreds of entries (173, 227, 310 and 414 files were all
   * observed in one session), so a guard sized for noise will always fire on prose.
   * Letting it fire FIRST meant the strongest signal a prompt can carry was thrown
   * away by the weakest.
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

  /**
   * A directory the developer named, when nothing was named outright.
   *
   * ALWAYS WIDENED, NEVER NEW, and that asymmetry is the safety in this rule. A
   * path or an identifier is unambiguous, so it may replace the boundary. A bare
   * word that happens to coincide with a directory name is not — `copy` is an
   * ordinary English word and also a directory in some repositories. Widening adds
   * the new area while KEEPING everything already in scope, so a coincidence costs
   * a boundary that is too broad, which challenges less (rule 1a). Replacing would
   * throw away the real task, which is the expensive mistake.
   *
   * Suppressed for a PASTE, exactly as the named-outright override is. A stack
   * trace mentions directory names in every frame, and a test caught this the
   * moment the rule was added: ten pasted paths under `backend/` widened the
   * boundary on the strength of the word "backend". A paste is noise whatever
   * shape its words happen to have.
   */
  if (areaHits.length > 0 && !pasted) {
    return {
      ...base,
      verdict: 'WIDENED',
      reason:
        `names ${areaHits.slice(0, 3).join(', ')}, which ${areaHits.length === 1 ? 'is a directory' : 'are directories'} ` +
        `outside the boundary`,
    };
  }

  /**
   * Fuzzy overlap only, now — so the noise guard applies to noise.
   *
   * Reached when the prompt named nothing outright, or named so much that it reads
   * as pasted output rather than as a person pointing at their work. Everything
   * below this line is a guess assembled from ordinary words.
   *
   * THE GUARD JUDGES THE SHARPEST WORD, NOT THE PILE.
   *
   * It used to test the UNION of everywhere any outside term landed, which meant
   * the vaguest word in a sentence decided the fate of the sharpest one. Measured
   * on the prompt that exposed this — *"different job now. the rate limiter needs
   * a clearer doc comment on how expired entries are purged."* — the per-term
   * spread on a 1,340-file repository was:
   *
   *     limiter    3 places   <- and the first is the exact file meant
   *     entries    2
   *     expired   16
   *     rate      59
   *     doc      135
   *
   * The union is 174, so the guard fired and the boundary never moved; Ichor then
   * spent five turns policing the previous task and challenged the work the
   * developer had just asked for. But `limiter` names three files. The prompt was
   * never vague — it merely contained vague words, which every sentence does.
   *
   * So a prompt is scattered only when NOTHING in it is focused. One term landing
   * in few places is a pointer, and the generic words beside it are ignored rather
   * than allowed to outvote it. When nothing is focused, the prompt genuinely says
   * nowhere, and NO_SIGNAL is still the right answer.
   */
  if (pasted) {
    const places = new Set([...spread, ...namedOutside]);
    if (places.size > MAX_OUTSIDE_SPREAD) {
      return {
        ...base,
        verdict: 'NO_SIGNAL',
        reason: `${namedOutside.length} names look pasted, and matches are scattered across ${places.size} files`,
      };
    }
  } else if (outsideHits.length > 0 && focusedFiles.size > MAX_OUTSIDE_SPREAD) {
    return {
      ...base,
      verdict: 'NO_SIGNAL',
      reason: `outside matches too scattered (${focusedFiles.size} files) to be a task`,
    };
  } else if (outsideHits.length > 0 && focusedOutside.length === 0) {
    return {
      ...base,
      verdict: 'NO_SIGNAL',
      reason:
        `outside matches too scattered to be a task — every term lands in more than ` +
        `${FOCUSED_TERM_PLACES} places (${spread.length} files in total)`,
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
  // Cite the FOCUSED terms, sharpest first: those are the ones that decided it,
  // and a log line naming `doc` when the answer came from `limiter` is a log line
  // that misleads whoever reads it next.
  const pointing = (
    focusedOutside.length
      ? [...focusedOutside].sort(
          (a, b) => (focusedPlaces.get(a) ?? 0) - (focusedPlaces.get(b) ?? 0) || a.localeCompare(b),
        )
      : outsideHits
  )
    .slice(0, 4)
    .join(', ');
  if (insideHits.length === 0) {
    return { ...base, verdict: 'NEW', reason: `points only outside the boundary (${pointing})` };
  }
  return {
    ...base,
    verdict: 'WIDENED',
    reason: `inside (${insideHits.slice(0, 4).join(', ')}) plus new ground (${pointing})`,
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
