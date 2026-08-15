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
  // Task verbs: every task says these, so they discriminate nothing.
  'fix', 'add', 'remove', 'update', 'change', 'make', 'handle', 'show', 'keep', 'return',
  'implement', 'create', 'delete', 'refactor', 'improve', 'support', 'use', 'set', 'get',
  'properly', 'correctly', 'instead', 'also', 'just', 'need', 'needs', 'want', 'like',
]);

export type AnchorKind = 'function' | 'route' | 'model' | 'field' | 'file';

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

/** Singular/plural tolerance without pulling in a stemmer. */
function matches(term: string, candidate: string): boolean {
  const c = candidate.toLowerCase();
  if (c.includes(term)) return true;
  if (term.endsWith('s') && c.includes(term.slice(0, -1))) return true;
  if (!term.endsWith('s') && c.includes(`${term}s`)) return true;
  return false;
}

export interface AnchorOptions {
  /** Keep at most this many anchors. Precision beats recall. */
  limit?: number;
  /** Drop anchors scoring below this. */
  minScore?: number;
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
  const limit = options.limit ?? 12;
  const minScore = options.minScore ?? 2;

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
      score: hits.length * 4,
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
      score: hits.length * 3,
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
    const modelHits = terms.filter((t) => matches(t, field.model));
    const score =
      hits.length * 2 +
      (field.isUnique ? 2 : 0) +
      (modelHits.length > 0 ? 3 : -3);

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

  // Functions — name first, then the file path as a weaker hint.
  for (const fn of facts.functions) {
    const nameHits = terms.filter((t) => matches(t, fn.name));
    const pathHits = terms.filter((t) => matches(t, fn.file) && !nameHits.includes(t));
    if (nameHits.length === 0 && pathHits.length === 0) continue;

    let score = nameHits.length * 3 + pathHits.length;
    if (fn.exported) score += 1;            // an entry point beats a private helper
    if (fn.isTest) score -= 1;              // tests follow the code, they do not anchor it

    const why = [
      nameHits.length ? `name matches ${nameHits.join(', ')}` : '',
      pathHits.length ? `path matches ${pathHits.join(', ')}` : '',
    ].filter(Boolean).join('; ');

    scored.push({ key: fn.key, kind: 'function', name: fn.name, file: fn.file, score, why });
  }

  const anchors = scored
    .filter((a) => a.score >= minScore)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);

  return { anchors, terms };
}
