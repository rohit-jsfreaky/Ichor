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

/** Words that carry no signal about which part of a codebase is meant. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did',
  'not', 'no', 'dont', 'doesnt', 'it', 'its', 'this', 'that', 'these', 'those', 'we', 'i', 'you',
  'should', 'would', 'could', 'can', 'will', 'please', 'instead', 'when', 'while', 'currently',
  'properly', 'correctly', 'instead', 'also', 'just', 'need', 'needs', 'want', 'like',
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
export function matches(term: string, candidate: string): boolean {
  const c = candidate.toLowerCase();
  if (c.includes(term)) return true;
  if (term.endsWith('s') && c.includes(term.slice(0, -1))) return true;
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
    if (nameHits.length === 0 && pathHits.length === 0) continue;

    let score = signal(nameHits) * 3 + signal(pathHits);

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

    const why = [
      nameHits.length ? `name matches ${nameHits.join(', ')}` : '',
      pathHits.length ? `path matches ${pathHits.join(', ')}` : '',
    ].filter(Boolean).join('; ');

    scored.push({ key: fn.key, kind: 'function', name: fn.name, file: fn.file, score, why });
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
