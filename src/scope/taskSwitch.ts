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
    let inside = false;
    const filesForTerm: string[] = [];

    for (const entry of index.entries) {
      if (!matches(term, entry.name) && !(entry.file && matches(term, entry.file))) continue;
      if (isInside(entry, boundary)) {
        inside = true;
        break; // already accounted for by the boundary; nothing more to learn
      }
      filesForTerm.push(locationOf(entry));
    }

    if (inside) {
      insideHits.push(term);
      continue;
    }
    if (filesForTerm.length > 0) {
      outsideHits.push(term);
      for (const f of filesForTerm) outsideFiles.add(f);
    }
  }

  const spread = [...outsideFiles];
  const base = { terms, insideHits, outsideHits, outsideFiles: spread };

  if (terms.length === 0) {
    return { ...base, verdict: 'NO_SIGNAL', reason: 'prompt names nothing in the codebase' };
  }
  if (insideHits.length === 0 && outsideHits.length === 0) {
    return { ...base, verdict: 'NO_SIGNAL', reason: 'no term matched any known symbol' };
  }
  if (outsideHits.length > 0 && spread.length > MAX_OUTSIDE_SPREAD) {
    // Looks like pasted output rather than a task. Stay put.
    return {
      ...base,
      verdict: 'NO_SIGNAL',
      reason: `outside matches too scattered (${spread.length} files) to be a task`,
    };
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
