/**
 * The fixture test.
 *
 * `demo/EXPECTED-GRAPH.md` was hand-derived from the source BEFORE the analyzer
 * existed. This asserts the analyzer reproduces it. It is how we know the graph
 * is true rather than merely plausible (docs/ENGINEERING-RULES.md rule 6), and
 * it is what lets us claim accuracy on camera.
 *
 * Needs no Docker — extraction is pure.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { analyzeRepo } from '../src/extract/analyze.js';
import type { GraphFacts } from '../src/extract/types.js';

const DEMO = path.resolve(process.cwd(), 'demo');

let facts: GraphFacts;

beforeAll(() => {
  facts = analyzeRepo(DEMO);
}, 120_000);

/** Is there a CALLS edge between two functions, by name? */
function calls(from: string, to: string): boolean {
  const name = (key: string) => facts.functions.find((f) => f.key === key)?.name;
  return facts.calls.some((c) => name(c.fromKey) === from && name(c.toKey) === to);
}

/** Does a function touch a model? */
function touches(fn: string, model: string): boolean {
  const fnName = (key: string) => facts.functions.find((f) => f.key === key)?.name;
  const modelName = (key: string) => facts.models.find((m) => m.key === key)?.name;
  return facts.touches.some((t) => fnName(t.fromKey) === fn && modelName(t.modelKey) === model);
}

describe('routes', () => {
  it('finds both vendor route handlers', () => {
    const found = facts.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(found).toEqual(['GET /api/vendors', 'POST /api/vendors']);
  });

  it('points each route at its handler in the right file', () => {
    const post = facts.routes.find((r) => r.method === 'POST');
    expect(post?.file).toBe('src/app/api/vendors/route.ts');
    expect(post?.handlerKey).toContain('route.ts#POST');
  });
});

describe('the task path — the chain the whole demo depends on', () => {
  it('POST reaches createVendor', () => {
    expect(calls('POST', 'createVendor')).toBe(true);
  });

  it('createVendor writes the Vendor model', () => {
    expect(touches('createVendor', 'Vendor')).toBe(true);
    const write = facts.touches.find(
      (t) => facts.functions.find((f) => f.key === t.fromKey)?.name === 'createVendor',
    );
    expect(write?.operation).toBe('create');
    expect(write?.isWrite).toBe(true);
  });

  it('Vendor.email is unique — the constraint the submit path already enforces', () => {
    const email = facts.fields.find((f) => f.model === 'Vendor' && f.name === 'email');
    expect(email).toBeDefined();
    expect(email?.isUnique).toBe(true);
  });

  it('the UI chain reaches the toast', () => {
    expect(calls('NewVendorPage', 'VendorForm')).toBe(true); // JSX, not a call expression
    expect(calls('VendorForm', 'submitVendor')).toBe(true);
    expect(calls('submitVendor', 'showToast')).toBe(true);
  });
});

describe('cross-file resolution', () => {
  it('resolves imported functions through the import alias', () => {
    // The regression that silently deletes every cross-file edge: an imported
    // identifier's symbol points at the ImportSpecifier, not the real function.
    expect(calls('POST', 'requireSession')).toBe(true);
    expect(calls('GET', 'listVendors')).toBe(true);
  });

  it('resolves same-file calls too', () => {
    expect(calls('requireSession', 'getSession')).toBe(true);
    expect(calls('getSession', 'readSessionCookie')).toBe(true);
  });

  it('keeps the unresolved rate low enough to trust the graph', () => {
    const rate = facts.stats.callSitesUnresolved / facts.stats.callSitesTotal;
    // Not zero, and we never pretend it is — but a high rate means missing
    // edges, which means false "this is disconnected" challenges.
    expect(rate).toBeLessThan(0.3);
  });
});

describe('unrelated areas stay unrelated', () => {
  it('billing touches Invoice and nothing in the vendor path calls it', () => {
    expect(touches('createInvoice', 'Invoice')).toBe(true);
    expect(calls('POST', 'createInvoice')).toBe(false);
    expect(calls('createVendor', 'createInvoice')).toBe(false);
  });

  it('auth reads Session and User, not Vendor', () => {
    expect(touches('getSession', 'Session')).toBe(true);
    expect(touches('getSession', 'User')).toBe(true);
    expect(touches('getSession', 'Vendor')).toBe(false);
  });
});

describe('schema', () => {
  it('reads all four models', () => {
    expect(facts.models.map((m) => m.name).sort()).toEqual(['Invoice', 'Session', 'User', 'Vendor']);
  });

  it('marks ids and uniques correctly', () => {
    const vendorId = facts.fields.find((f) => f.model === 'Vendor' && f.name === 'id');
    expect(vendorId?.isId).toBe(true);
    expect(facts.fields.filter((f) => f.isUnique).map((f) => `${f.model}.${f.name}`).sort())
      .toEqual(['User.email', 'Vendor.email']);
  });
});

describe('locations', () => {
  it('every function carries a citable file and line', () => {
    for (const fn of facts.functions) {
      expect(fn.file).toMatch(/^(src|test)\//); // repo-relative, POSIX
      expect(fn.line).toBeGreaterThan(0);
    }
  });
});
