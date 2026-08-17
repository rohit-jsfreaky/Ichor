/**
 * Find the seed nodes for a task — step one of building a neighbourhood.
 *
 * Given "fix duplicate email handling in vendor onboarding", find the places in
 * the graph the task is obviously about: the vendor route, createVendor, the
 * Vendor model, the email field.
 *
 * DELIBERATELY DETERMINISTIC. No LLM here, for two reasons:
 *
 *  1. Ichor must work with no API key at all. Anchoring is the first
 *     step, so if it needed a key, nothing would work without one.
 *  2. It is testable. An LLM anchor step cannot be asserted against a fixture.
 *
 * The Judge reasons about *intent* later, on the handful of cases that are
 * genuinely ambiguous. This is the cheap, explainable base layer.
 */

import type { GraphFacts } from '../extract/types.js';
import { namedTokens } from './named.js';

/**
 * How many files a named path may resolve to before it stops being precise.
 *
 * `smtp-service.ts` resolving to one file is the developer pointing at their
 * work. `index.ts` resolving to two hundred is not a signal at all, and treating
 * it as one would seed the boundary from an arbitrary handful of them.
 */
const NAMED_FILES_MAX = 3;

/** Words that carry no signal about which part of a codebase is meant. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did',
  'not', 'no', 'dont', 'doesnt', 'it', 'its', 'this', 'that', 'these', 'those', 'we', 'i', 'you',
  'should', 'would', 'could', 'can', 'will', 'please', 'instead', 'when', 'while', 'currently',
  'properly', 'correctly', 'instead', 'also', 'just', 'need', 'needs', 'want', 'like',
  // Auxiliaries and fillers that survive as SUBSTRINGS of real identifiers.
  // "has" is inside "downloadJobP·has·e", "was" inside "·was·mCleanup", "our"
  // inside "res·our·ce". They carry no intent and match a great deal, so on a
  // real repo they put a type alias fifth in a search about link expiry.
  'has', 'have', 'had', 'whether', 'where', 'what', 'which', 'who', 'why', 'how',
  'our', 'your', 'their', 'them', 'they', 'some', 'any', 'all', 'each', 'into',
  'out', 'own', 'via', 'per', 'about', 'after', 'before', 'still', 'only', 'ever',
]);

// Task verbs — "fix", "add", "delete", "update" — are deliberately NOT listed.
//
// They used to be, on the reasoning that every task says them so they
// discriminate nothing. That is true of "fix" and false of "delete": in a
// product with a DeleteLinkModal and thirty other modals, "delete" is the only
// word in "fix the typo in the delete link confirmation modal" that separates
// the right component from the wrong ones. Striking it left "link modal", which
// cannot.
//
// Damping now does this job properly and per-codebase: a verb that really is
// everywhere matches hundreds of names and is damped to nothing automatically,
// while one that names a specific thing here keeps its weight. A fixed list
// cannot tell those two cases apart; counting can.

export type AnchorKind = 'function' | 'route' | 'model' | 'field' | 'file' | 'type';

export interface Anchor {
  key: string;
  kind: AnchorKind;
  /** Display name, e.g. `createVendor` or `POST /api/vendors`. */
  name: string;
  file?: string;
  /** Higher is a better match. */
  score: number;
  /** Human-readable justification — shown to the developer, never invented. */
  why: string;
}

/**
 * Split a task sentence into meaningful terms.
 *
 * Also splits identifiers, so a task mentioning `createVendor` yields
 * `createvendor`, `create` and `vendor`.
 */
export function taskTerms(task: string): string[] {
  const raw = task
    .replace(/[^\w\s/-]/g, ' ')
    .split(/[\s/_-]+/)
    .filter(Boolean);

  const terms = new Set<string>();
  for (const word of raw) {
    // camelCase / PascalCase -> parts
    for (const part of word.split(/(?=[A-Z])/)) {
      const lower = part.toLowerCase();
      if (lower.length < 3 || STOP_WORDS.has(lower)) continue;
      terms.add(lower);
    }
    const whole = word.toLowerCase();
    if (whole.length >= 3 && !STOP_WORDS.has(whole)) terms.add(whole);
  }
  return [...terms];
}

/**
 * Singular/plural tolerance without pulling in a stemmer.
 *
 * Exported because task-switch detection must match a new prompt against the
 * codebase using EXACTLY the rule that drew the boundary in the first place.
 * Two near-identical matchers would drift apart and produce a boundary that
 * disagrees with the detector that maintains it (ENGINEERING-RULES rule 3).
 */
/**
 * Shortest stem allowed after stripping a suffix.
 *
 * Without it, plural-stripping turns a three-letter word into a two-letter
 * substring that matches most of a codebase: "has" becomes "ha", which is inside
 * "s**ha**re", "c**ha**rt" and "**ha**ndle". On a real repo that put icon
 * components at the top of a search for expiry enforcement. The -ing/-ed rule
 * below always had this floor; the plural rule did not.
 */
const MIN_STEM = 4;

export function matches(term: string, candidate: string): boolean {
  const c = candidate.toLowerCase();
  if (c.includes(term)) return true;
  if (term.endsWith('s') && term.length - 1 >= MIN_STEM && c.includes(term.slice(0, -1))) return true;
  if (!term.endsWith('s') && c.includes(`${term}s`)) return true;

  // Verb forms of a noun the codebase names directly: "invoicing" must reach
  // `Invoice`, or "add invoicing for vendors" reads as more vendor work and the
  // boundary never moves. The 4-character floor on the stem is what stops this
  // becoming a wildcard — "string" would otherwise stem to "str" and match half
  // the repo.
  for (const suffix of ['ing', 'ed']) {
    if (!term.endsWith(suffix)) continue;
    const stem = term.slice(0, -suffix.length);
    if (stem.length >= 4 && c.includes(stem)) return true;
  }
  return false;
}

export interface AnchorOptions {
  /** Keep at most this many anchors. Precision beats recall. */
  limit?: number;
  /** Absolute floor, below which a match is noise whatever else scored. */
  minScore?: number;
  /**
   * Damp terms that match a great many things. On by default.
   *
   * Exposed so the ground-truth harness can measure what it costs. There is a
   * real tension here: in a link-sharing product the word "link" matches
   * hundreds of names AND is genuinely the subject of half the tasks, so the
   * damping that stops a boundary swallowing the repo can also suppress the
   * correct answer. That trade needs measuring, not asserting.
   */
  rarityWeighting?: boolean;
  /**
   * Seed from the files the prompt named, when it named any. On by default.
   *
   * Exposed for the same reason as `rarityWeighting`: the claim that this
   * narrows a small task without loosening a large one is a measurement, and a
   * measurement needs both sides. `scripts/named-seed-gate.ts` runs it off and on
   * over the same facts.
   */
  namedFileSeeding?: boolean;
}

/** Keep anchors within this share of the best one found for the prompt. */
const RELATIVE_CUTOFF = 0.15;

/**
 * A term that matches more places than a task could plausibly span is not
 * telling you where the task is.
 *
 * Every word used to count the same, and that is what made the task area
 * useless on a large codebase: in a link-sharing product "link" matches 892
 * names, so it dragged in a fifth of the repository, while "watermark" matches
 * six and says almost exactly where to look.
 *
 * The control has to be ABSOLUTE, not relative. Measured: "vendor" covers ~17%
 * of the names in the demo and "link" covers ~15% of papermark's — practically
 * the same share — yet seeding all 10 vendor matches is right and seeding all
 * 892 link matches is ruinous. Proportion cannot separate those two; the raw
 * count separates them immediately.
 *
 * So a term is worth full weight until it matches more places than a task
 * plausibly touches, and decays from there. Below the knee nothing changes at
 * all, which is why every existing scenario behaves exactly as before.
 */
const BROAD_TERM_MATCHES = 25;

/**
 * The part of a qualified name that identifies the function itself.
 *
 * `VendorForm.handleSubmit` is stored qualified so a nested handler cannot
 * collide with a top-level one — but for matching a task's words, only
 * `handleSubmit` is this function's own name. Scoring the whole string makes
 * every nested function inherit its parent's words, and the damage is not
 * cosmetic: on the demo, `VendorForm.set` scored as a match for "vendor" and
 * "form", which flooded those terms, drove their rarity weight down, and pushed
 * the genuinely correct anchor `submitVendor` below the bar.
 *
 * The parent's relevance is not lost — the parent is scored on its own, and
 * containment brings its children in at the same distance anyway.
 */
function ownName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

function termWeights(facts: GraphFacts, terms: string[]): Map<string, number> {
  // Every name a term could plausibly land on, counted once.
  const names: string[] = [
    ...facts.functions.map((f) => ownName(f.name)),
    ...facts.types.map((t) => t.name),
    ...facts.models.map((m) => m.name),
    ...facts.fields.map((f) => `${f.model}.${f.name}`),
    ...facts.routes.map((r) => r.path),
    ...facts.files.map((f) => f.path),
  ];

  const raw = new Map<string, number>();
  for (const term of terms) {
    let hits = 0;
    for (const name of names) if (matches(term, name)) hits++;
    // A term matching nothing can never contribute; keeping it out of the scale
    // below is what stops an unmatched word setting the bar for the rest.
    raw.set(term, hits === 0 ? 0 : Math.min(1, BROAD_TERM_MATCHES / hits));
  }

  // Rescale so the strongest MATCHING word in this prompt is worth 1.
  //
  // Without this, damping shrinks every score — and by a different amount in
  // every codebase — so an absolute threshold stops meaning the same thing.
  // Measured: the correct anchor for a real task fell to 0.64 on a large repo
  // while the demo's sat at 7, and no single cut-off could serve both. Rescaling
  // restores comparability: the demo, where nothing is over-broad, is unchanged
  // because its strongest term was already 1.
  const strongest = Math.max(...raw.values(), 0);
  if (strongest === 0) return raw;

  const weights = new Map<string, number>();
  for (const [term, value] of raw) weights.set(term, value / strongest);
  return weights;
}

/**
 * Score every node against the task terms and keep the best.
 *
 * Weighting reflects how strongly each node type states intent. A route path or
 * a model name naming a task term is a much stronger signal than a file path
 * happening to contain it.
 */
/**
 * Phrases the prompt quotes outright.
 *
 * A developer asking for a wording change usually PASTES the wording: *the message
 * says 'Link has expired.'*. That is not a word-overlap signal, it is the code's own
 * text repeated back — the strongest and most specific evidence a prompt can carry,
 * and Ichor was throwing it away with the quote marks.
 *
 * Straight and typographic quotes both, because a prompt written in a chat box
 * usually has the curly ones and the source always has the straight ones.
 */
export function quotedPhrases(task: string): string[] {
  const found = new Set<string>();
  for (const match of task.matchAll(/["'`“”‘’]([^"'`“”‘’]{6,120})["'`“”‘’]/g)) {
    const phrase = match[1]!.trim().toLowerCase();
    // Two words minimum: a single quoted word is usually an identifier, and those
    // are already handled by name matching.
    if (/\s/.test(phrase)) found.add(phrase);
  }
  return [...found];
}

/**
 * Files the prompt named outright, resolved against what is actually in the repo.
 *
 * A prompt rarely spells out a full repo-relative path — it says
 * `smtp-service.ts`, not `backend/src/services/smtp/smtp-service.ts` — so a
 * named path matches on a trailing path segment boundary. Anchored at `/` so
 * `service.ts` cannot match `smtp-service.ts`, which is a different file.
 *
 * Returns nothing unless the resolution is unambiguous. An ambiguous name is
 * worse than no name: it looks like precision and is not.
 */
function namedFiles(facts: GraphFacts, task: string): string[] {
  const named = namedTokens(task).paths;
  if (named.length === 0 || named.length > NAMED_FILES_MAX) return [];

  const resolved = new Set<string>();
  for (const wanted of named) {
    const hits = facts.files
      .map((f) => f.path)
      .filter((p) => {
        const lower = p.toLowerCase();
        return lower === wanted || lower.endsWith(`/${wanted}`);
      });

    /**
     * How many hits are acceptable depends on how much the developer told us.
     *
     * A bare `reminder.ts` carries NO disambiguating information: if the repo has
     * a mail one and a settings one, nothing in the prompt says which, and
     * picking both seeds a boundary from a file the developer may never have
     * meant. So a bare name has to be unique.
     *
     * `lib/mail/reminder.ts` is different — the directories ARE the
     * disambiguation, and a couple of hits means a monorepo with parallel
     * packages, where seeding from each is right.
     *
     * This distinction was missing at first and a test caught it: `index.ts`
     * matched exactly two files, two was under the limit, and an entirely
     * ambiguous name was treated as a precise pointer. On a real repo `index.ts`
     * matches hundreds and would have been rejected — the dangerous case is the
     * small number, which is the one a limit alone lets through.
     */
    const bare = !wanted.includes('/');
    const allowed = bare ? 1 : NAMED_FILES_MAX;
    if (hits.length === 0 || hits.length > allowed) return [];
    for (const hit of hits) resolved.add(hit);
  }

  return resolved.size > 0 && resolved.size <= NAMED_FILES_MAX ? [...resolved] : [];
}

export function findAnchors(
  facts: GraphFacts,
  task: string,
  options: AnchorOptions = {},
): { anchors: Anchor[]; terms: string[] } {
  const terms = taskTerms(task);
  /**
   * 60, not 12 — measured against 30 real commits.
   *
   * The old cap of 12 was hit by ALL 30 of them, which means it was never a
   * backstop against noise; it WAS the selection rule, and it had never been
   * checked against anything. Raising it cut the share of real edits Ichor
   * wrongly challenged from 41% to 19%.
   */
  const limit = options.limit ?? 60;
  const minScore = options.minScore ?? 2;

  /**
   * Damping is OFF by default, because measurement reversed the reasoning behind it.
   *
   * The idea was sound in the abstract: a word matching hundreds of names cannot
   * tell you where a task is. But in a real product the most common word is
   * usually the SUBJECT — "link" matches half of a link-sharing codebase and is
   * also what half its tasks are about. Damping it suppressed the correct
   * answers, and against 30 real commits turning it off cut wrongly challenged
   * edits from 38.6% to 19.3%.
   *
   * Kept, not deleted: it is still the right instinct for a codebase whose
   * vocabulary is not dominated by one domain, and the harness can measure it.
   */
  const phrases = quotedPhrases(task);
  const weight = options.rarityWeighting === true ? termWeights(facts, terms) : new Map<string, number>();
  /** Score a set of matched terms by how much each one actually narrows things down. */
  const signal = (hits: string[]) => hits.reduce((sum, t) => sum + (weight.get(t) ?? 1), 0);

  const scored: Anchor[] = [];

  // Routes — a URL naming the feature is the strongest signal there is.
  for (const route of facts.routes) {
    const hits = terms.filter((t) => matches(t, route.path));
    if (hits.length === 0) continue;
    scored.push({
      key: route.key,
      kind: 'route',
      name: `${route.method} ${route.path}`,
      file: route.file,
      score: signal(hits) * 4,
      why: `route path matches ${hits.join(', ')}`,
    });
  }

  // Models and fields — the data the task is about.
  for (const model of facts.models) {
    const hits = terms.filter((t) => matches(t, model.name));
    if (hits.length === 0) continue;
    scored.push({
      key: model.key,
      kind: 'model',
      name: model.name,
      score: signal(hits) * 3,
      why: `model name matches ${hits.join(', ')}`,
    });
  }

  for (const field of facts.fields) {
    const hits = terms.filter((t) => matches(t, field.name));
    if (hits.length === 0) continue;

    // A field name alone is a weak, noisy signal: "email" matches User.email,
    // Customer.email and Account.email in any real codebase, and seeding from
    // all of them drags unrelated subsystems into the neighbourhood. (Observed:
    // User.email pulled the whole auth module into a vendor task.)
    //
    // So the model has to corroborate it. Vendor.email in a task about vendors
    // is the crux of the bug; User.email in the same task is noise.
    // Every bonus is scaled by the signal that earns it.
    //
    // Flat bonuses were the second half of the same bug: with "link" damped to
    // 0.06, `Link.linkType` still scored 3.12 on a +3 corroboration bonus alone
    // and outranked `useDeleteLinkModal`, the actual subject. A bonus for being
    // corroborated by a model is worth nothing when the match being corroborated
    // is worth nothing.
    const modelHits = terms.filter((t) => matches(t, field.model));
    const nameSignal = signal(hits);
    const score =
      nameSignal * 2 +
      (field.isUnique ? nameSignal * 2 : 0) +
      (modelHits.length > 0 ? signal(modelHits) * 3 : -3);

    scored.push({
      key: field.key,
      kind: 'field',
      name: `${field.model}.${field.name}`,
      score,
      why:
        `field matches ${hits.join(', ')}` +
        (field.isUnique ? ' (unique constraint)' : '') +
        (modelHits.length ? ` on model matching ${modelHits.join(', ')}` : ''),
    });
  }

  // Types — interfaces, aliases, enums, classes.
  //
  // Weighted just under a Prisma model. Both name the SHAPE of the data a task
  // is about, and in an app without Prisma a type is the ONLY thing that does:
  // "add a status field to the Vendor type" had nothing to anchor to before.
  for (const type of facts.types) {
    const hits = terms.filter((t) => matches(t, type.name));
    if (hits.length === 0) continue;

    scored.push({
      key: type.key,
      kind: 'type',
      name: type.name,
      file: type.file,
      // Exported types are the ones other code can be about; a local helper type
      // is usually incidental to the task.
      score: signal(hits) * (type.exported ? 4 : 3),
      why: `${type.kind} name matches ${hits.join(', ')}`,
    });
  }

  // Functions — how WELL a term matches, not merely how many matched.
  for (const fn of facts.functions) {
    const own = ownName(fn.name);
    const nameHits = terms.filter((t) => matches(t, own));
    const pathHits = terms.filter((t) => matches(t, fn.file));

    /**
     * Terms found in the strings this function WRITES.
     *
     * The signal a codebase's own vocabulary cannot give. *"The expired-link message
     * shown to viewers says 'Link has expired.' — make it friendlier"* names its
     * subject only as user-facing copy: the two functions holding that string are
     * both called `POST`, in files called `route.ts`, so nothing in a name or a path
     * points at them. Ichor drew a 393-function boundary that reached neither, then
     * challenged both when the agent — correctly — edited them.
     *
     * Weighted at 2, between a path match (1) and a name match (3). A function that
     * says the words the task quotes is strong evidence, and weaker than one NAMED
     * after them: plenty of functions mention "link" in an error message without
     * being about links.
     */
    const textHits = fn.text?.length
      ? terms.filter((t) => fn.text!.some((line) => matches(t, line)))
      : [];

    if (nameHits.length === 0 && pathHits.length === 0 && textHits.length === 0) continue;

    let score = signal(nameHits) * 3 + signal(pathHits) + signal(textHits) * 2;

    /**
     * A term that IS the name, rather than appearing somewhere inside it.
     *
     * Counting matched terms alone ranks `CustomFieldsPreviewDemo` — which
     * happens to contain two common words — above `Branding`, whose entire name
     * is the subject of the task. Measured against real commits, that is how
     * `pages/branding.tsx` came to be challenged during a task whose own message
     * said "branding": the file every word pointed at was not even in the top 60
     * candidates.
     */
    const exact = nameHits.filter((t) => own.toLowerCase() === t || own.toLowerCase() === `${t}s`);
    if (exact.length) score *= 2.5;

    /**
     * The same term in the name AND the path.
     *
     * This used to be thrown away — a term that matched the name was struck out
     * of the path hits as redundant. It is the opposite of redundant: the file
     * is about this thing and so is the function in it. That is the strongest
     * agreement two independent signals can give.
     */
    const both = nameHits.filter((t) => pathHits.includes(t));
    if (both.length) score *= 1.6;

    if (fn.exported) score *= 1.3;          // an entry point beats a private helper
    if (fn.isTest) score *= 0.5;            // tests follow the code, they do not anchor it

    /**
     * A phrase the task quotes almost verbatim.
     *
     * "Link has expired" against a task mentioning *expired* and *link* is not a
     * coincidence, and a function whose own text carries SEVERAL of the task's terms
     * is very likely the one being described. Scaled rather than flat, so it cannot
     * lift a function that merely shares one common word.
     */
    if (textHits.length >= 2) score *= 1.8;

    /**
     * The prompt quoted this function's own text, verbatim.
     *
     * Treated like an exact name match, because that is what it is: the developer
     * has pointed at the code, just with a string instead of an identifier. It is
     * the only signal that reaches a handler named `POST` in a file named
     * `route.ts` — nothing about its name or path says "expired link", and both
     * copies of that message live in exactly such a function. Before this, the
     * boundary reached NEITHER and then challenged both when the agent edited them.
     *
     * A quoted multi-word phrase appearing verbatim in a function is not a
     * coincidence, so it is allowed to lift a candidate that scored nothing
     * otherwise.
     */
    const saysExactly =
      phrases.length > 0 &&
      (fn.text ?? []).some((line) => {
        const said = line.toLowerCase();
        return phrases.some((phrase) => said.includes(phrase) || phrase.includes(said));
      });
    if (saysExactly) score = Math.max(score, 1) * 6;

    const why = [
      nameHits.length ? `name matches ${nameHits.join(', ')}` : '',
      pathHits.length ? `path matches ${pathHits.join(', ')}` : '',
      saysExactly ? 'says the exact words the task quoted' : '',
      textHits.length ? `says ${textHits.join(', ')}` : '',
    ].filter(Boolean).join('; ');

    scored.push({ key: fn.key, kind: 'function', name: fn.name, file: fn.file, score, why });
  }

  /**
   * When the prompt named the files, those files ARE the task.
   *
   * WHY THIS EXISTS
   *
   * Asked to add one comment line to one backend file, Ichor drew a boundary of
   * 179 functions across 91 files. The agent reading that briefing said it
   * plainly: the list included frontend components, an Intune connection helper
   * and Databricks rotation fields, and "reads like a keyword expansion on
   * service / email / smtp, not the scope of the quoted task".
   *
   * It was right, and the cause was that scoring has no notion of how BIG a task
   * is. "Add a comment to one file" and "rework the reminder pipeline" produce
   * the same shape of search across every term in the sentence, so a small task
   * in a large repo gets a boundary sized by the repo rather than by the job.
   *
   * A developer who types a path has already answered the question the scorer is
   * guessing at. So when the naming is unambiguous, seed from those files and let
   * the graph walk do the widening — callers and callees of the named code are
   * found downstream, from structure, which is a better answer than more words.
   *
   * Deliberately narrow in scope:
   *   - only when every named path resolves, and to few enough files to be a
   *     genuine pointer rather than a coincidence
   *   - only when something in those files actually scored, so a stale or
   *     mistyped path falls back to ordinary matching rather than emptying the
   *     boundary. An empty boundary challenges everything.
   *
   * Measured, not assumed: `ground-truth.ts` replays 30 real commits, whose
   * messages almost never name a path, so this must leave that number where it
   * was. If it moves, this is doing something other than what it claims.
   */
  const named = options.namedFileSeeding === false ? [] : namedFiles(facts, task);
  if (named.length > 0) {
    /**
     * EVERY declaration in the named file, not only the ones that matched a word.
     *
     * Seeding from just the term-matching anchors looked tidier and was wrong in
     * the more dangerous direction. "Add a comment explaining the retry logic in
     * utils.ts" matched exactly one function, so the boundary became one function
     * and its neighbours — and a boundary that is too NARROW challenges more, not
     * less. Ichor would then have argued with the developer about the very file
     * they had just named.
     *
     * A developer working in a file is working in the file. Term matches still
     * rank it — the crux of the task sorts to the top and survives `limit` on a
     * long file — but a plain helper in the same file is in scope because of where
     * it lives, which is exactly the kind of claim structure is allowed to make.
     */
    const scoredInNamed = new Map(
      scored.filter((a) => a.file && named.includes(a.file)).map((a) => [a.key, a]),
    );

    const seeds: Anchor[] = [];
    for (const fn of facts.functions) {
      if (!named.includes(fn.file)) continue;
      const already = scoredInNamed.get(fn.key);
      seeds.push(
        already
          ? { ...already, why: `${already.why}; in ${fn.file}, which the task named` }
          : {
              key: fn.key,
              kind: 'function',
              name: fn.name,
              file: fn.file,
              // Below anything that matched a term, above nothing at all.
              score: 0.5,
              why: `declared in ${fn.file}, which the task named`,
            },
      );
    }

    // A named path that resolved to a file holding no declarations we know about
    // — a barrel, a type-only module — is not a usable seed. Fall through rather
    // than return an empty boundary, which would challenge everything.
    if (seeds.length > 0) {
      const anchors = seeds
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, limit);
      return { anchors, terms };
    }
  }

  // Relative, not absolute.
  //
  // A fixed threshold assumes scores mean the same thing in every codebase, and
  // once common words are damped they do not: on a large repo the best anchor
  // for a real task scored 1.64, so a floor of 2 discarded every correct answer
  // and kept only the bonus-inflated noise above it. Keeping everything within
  // a share of the best candidate adapts to whatever the prompt could find.
  const best = scored.reduce((m, a) => Math.max(m, a.score), 0);
  const cutoff = Math.max(minScore, best * RELATIVE_CUTOFF);

  const anchors = scored
    .filter((a) => a.score >= cutoff)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);

  return { anchors, terms };
}
