/**
 * Task-switch detection.
 *
 * This is the piece that decides whether to move a boundary the developer never
 * asked us to move, so it gets the most tests in the project. Every case here
 * is one row of the edge-case table in the plan, and the bias runs one way: when
 * a prompt is ambiguous the answer must be NO_SIGNAL, because that changes
 * nothing (ENGINEERING-RULES rule 1a).
 */

import { describe, expect, it } from 'vitest';

import { buildNameIndex, classifyPrompt, type BoundaryView } from '../src/scope/taskSwitch.js';
import type { GraphFacts } from '../src/extract/types.js';

/** A stand-in for the demo app, plus enough unrelated modules to test spread. */
function fixtureFacts(): GraphFacts {
  const fn = (name: string, file: string) => ({
    key: `function:${file}#${name}`,
    name,
    file,
    line: 1,
    exported: true,
    isComponent: /^[A-Z]/.test(name),
    isTest: false,
  });

  const functions = [
    // the vendor task area
    fn('createVendor', 'src/lib/vendors/create.ts'),
    fn('getVendor', 'src/lib/vendors/create.ts'),
    fn('listVendors', 'src/lib/vendors/create.ts'),
    fn('submitVendor', 'src/lib/vendors/submit.ts'),
    fn('isDuplicateEmailError', 'src/lib/vendors/errors.ts'),
    fn('VendorForm', 'src/components/VendorForm.tsx'),
    fn('showToast', 'src/lib/ui/toast.ts'),
    // billing — the switch target
    fn('createInvoice', 'src/lib/billing/invoice.ts'),
    fn('markInvoicePaid', 'src/lib/billing/invoice.ts'),
    fn('listUnpaidInvoices', 'src/lib/billing/invoice.ts'),
    // auth
    fn('requireSession', 'src/lib/auth/session.ts'),
    // a scattering of unrelated modules, for the spread guard
    ...['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet']
      .map((n) => fn(`${n}Widget`, `src/lib/misc/${n}.ts`)),
  ];

  const files = [...new Set(functions.map((f) => f.file))].map((path) => ({
    key: `file:${path}`,
    path,
  }));

  return {
    repoRoot: '/repo',
    files,
    functions,
    routes: [
      {
        key: 'route:GET /api/vendors',
        method: 'GET',
        path: '/api/vendors',
        handlerKey: 'function:src/app/api/vendors/route.ts#GET',
        file: 'src/app/api/vendors/route.ts',
        line: 1,
      },
    ],
    models: [
      { key: 'model:Vendor', name: 'Vendor' },
      { key: 'model:Invoice', name: 'Invoice' },
    ],
    fields: [
      { key: 'field:Vendor.email', model: 'Vendor', name: 'email', type: 'String', isUnique: true, isId: false },
      { key: 'field:Invoice.amount', model: 'Invoice', name: 'amount', type: 'Int', isUnique: false, isId: false },
    ],
    types: [
      { key: 'type:src/lib/vendors/types.ts#Vendor', name: 'Vendor', kind: 'interface',
        file: 'src/lib/vendors/types.ts', line: 1, exported: true },
      { key: 'type:src/lib/billing/types.ts#Invoice', name: 'Invoice', kind: 'interface',
        file: 'src/lib/billing/types.ts', line: 1, exported: true },
    ],
    calls: [],
    references: [],
    touches: [],
    imports: [],
    stats: {
      filesScanned: files.length,
      callSitesTotal: 0,
      callSitesResolvedInRepo: 0,
      callSitesExternal: 0,
      callSitesUnresolved: 0,
      typeRefsResolved: 0,
      typeRefsUnresolved: 0,
      durationMs: 0,
    },
  } as unknown as GraphFacts;
}

const index = buildNameIndex(fixtureFacts(), '2026-08-15T00:00:00.000Z');

/** The boundary a "fix duplicate email in vendor onboarding" task would draw. */
const vendorBoundary: BoundaryView = {
  names: [
    'createVendor', 'getVendor', 'listVendors', 'submitVendor',
    'isDuplicateEmailError', 'VendorForm', 'showToast', 'Vendor', 'Vendor.email',
  ],
  files: [
    'src/lib/vendors/create.ts',
    'src/lib/vendors/submit.ts',
    'src/lib/vendors/errors.ts',
    'src/components/VendorForm.tsx',
    'src/lib/ui/toast.ts',
  ],
};

const verdictOf = (prompt: string) => classifyPrompt(prompt, index, vendorBoundary).verdict;

describe('the index', () => {
  it('covers every kind a prompt could name', () => {
    const kinds = new Set(index.entries.map((e) => e.kind));
    expect(kinds).toContain('function');
    expect(kinds).toContain('route');
    expect(kinds).toContain('model');
    expect(kinds).toContain('field');
    // Files earn an entry so "fix src/lib/billing/invoice.ts" resolves without
    // naming a single symbol inside it.
    expect(kinds).toContain('file');
  });
});

describe('prompts that must change nothing', () => {
  // Redrawing on any of these would move the boundary every time the developer
  // says "keep going", which is most of what anyone types.
  it.each([
    ['continue'],
    ['yes'],
    ['fix it'],
    ['that did not work'],
    ['why did you do that?'],
    ['go on'],
    ['no, do it in the service layer instead'],
    ['корректно обработать ошибку'],
    [''],
  ])('%j -> NO_SIGNAL', (prompt) => {
    expect(verdictOf(prompt)).toBe('NO_SIGNAL');
  });

  it('ignores structural path words so a file path does not light up the repo', () => {
    // `src` and `lib` appear in every file; only `billing` and `invoice` carry signal.
    const result = classifyPrompt('look at src/lib', index, vendorBoundary);
    expect(result.terms).not.toContain('src');
    expect(result.terms).not.toContain('lib');
    expect(result.verdict).toBe('NO_SIGNAL');
  });

  it('distrusts a pasted stack trace rather than acting on it', () => {
    const trace = [
      'this failed:',
      'at alphaWidget (src/lib/misc/alpha.ts:3)',
      'at bravoWidget (src/lib/misc/bravo.ts:3)',
      'at charlieWidget (src/lib/misc/charlie.ts:3)',
      'at deltaWidget (src/lib/misc/delta.ts:3)',
      'at echoWidget (src/lib/misc/echo.ts:3)',
      'at foxtrotWidget (src/lib/misc/foxtrot.ts:3)',
      'at golfWidget (src/lib/misc/golf.ts:3)',
      'at hotelWidget (src/lib/misc/hotel.ts:3)',
      'at indiaWidget (src/lib/misc/india.ts:3)',
      'at julietWidget (src/lib/misc/juliet.ts:3)',
    ].join('\n');

    const result = classifyPrompt(trace, index, vendorBoundary);
    expect(result.verdict).toBe('NO_SIGNAL');
    expect(result.reason).toMatch(/scattered/);
  });
});

describe('staying on the same job', () => {
  it('recognises more work on the same area', () => {
    expect(verdictOf('the toast for a duplicate email is still wrong')).toBe('SAME');
  });

  it('recognises the original task itself', () => {
    expect(
      verdictOf('Duplicate email in vendor onboarding returns 500, show a toast'),
    ).toBe('SAME');
  });
});

describe('switching job', () => {
  it('detects a clean switch to another area', () => {
    const result = classifyPrompt('now fix the billing rounding', index, vendorBoundary);
    expect(result.verdict).toBe('NEW');
    expect(result.outsideHits).toContain('billing');
  });

  it('detects a switch named only by file path', () => {
    expect(verdictOf('fix the rounding in src/lib/billing/invoice.ts')).toBe('NEW');
  });

  it('detects a switch named only by model', () => {
    expect(verdictOf('invoices are not marked paid')).toBe('NEW');
  });

  it('counts a model and all its fields as ONE place, not many', () => {
    // A live run failed here: `Invoice` plus its six fields read as seven
    // scattered locations, tripped the spread guard, and "fix the billing
    // invoice rounding" was dismissed as noise.
    const result = classifyPrompt('now fix the billing invoice rounding', index, vendorBoundary);
    expect(result.verdict).toBe('NEW');
    expect(result.outsideFiles).toContain('src/lib/billing/invoice.ts');
    expect(result.outsideFiles).toContain('model:Invoice');
    expect(result.outsideFiles.filter((f) => f.startsWith('model:Invoice.'))).toEqual([]);
  });

  it('a single new noun is enough — real switches are short', () => {
    // Requiring two or more outside hits would miss "now fix the billing rounding",
    // which is exactly how people actually change subject.
    const result = classifyPrompt('now the billing part', index, vendorBoundary);
    expect(result.outsideHits).toHaveLength(1);
    expect(result.verdict).toBe('NEW');
  });
});

describe('widening the job', () => {
  it('keeps the boundary when a prompt spans old and new ground', () => {
    const result = classifyPrompt('add invoicing for vendors', index, vendorBoundary);
    expect(result.verdict).toBe('WIDENED');
    expect(result.insideHits.length).toBeGreaterThan(0);
    expect(result.outsideHits.length).toBeGreaterThan(0);
  });
});

describe('explainability', () => {
  it('always gives a reason that names the terms it used', () => {
    for (const prompt of ['now fix the billing rounding', 'add invoicing for vendors', 'continue']) {
      const result = classifyPrompt(prompt, index, vendorBoundary);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('never reports a term as both inside and outside', () => {
    const result = classifyPrompt('add invoicing for vendors', index, vendorBoundary);
    for (const term of result.insideHits) expect(result.outsideHits).not.toContain(term);
  });
});
