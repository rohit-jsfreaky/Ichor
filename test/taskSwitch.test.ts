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

import {
  buildNameIndex,
  classifyPrompt,
  isQuestion,
  type BoundaryView,
} from '../src/scope/taskSwitch.js';
import { namedTokens } from '../src/scope/named.js';
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

/**
 * The transcripts these came from are in BUGS.md, bugs 4 and 7.
 *
 * Both were found in real Claude Code sessions on papermark, and both passed every
 * one of the 109 unit tests that existed at the time.
 */
describe('a prompt that names something outright (bug 4)', () => {
  it('does not read a named outside file as the same job', () => {
    // The real transcript. It was classified SAME on the words `extract, file,
    // update, imports` — `src/lib/billing/invoice.ts` was shredded into `src`,
    // `lib`, `billing`, `invoice`, `ts`, and the structural ones were discarded.
    const result = classifyPrompt(
      'Also refactor src/lib/billing/invoice.ts: extract the createInvoice helper into its own file and update imports',
      index,
      vendorBoundary,
    );
    expect(result.verdict).not.toBe('SAME');
    expect(result.namedOutside.length).toBeGreaterThan(0);
  });

  it('says which named thing moved it', () => {
    const result = classifyPrompt(
      'now update src/lib/billing/invoice.ts',
      index,
      vendorBoundary,
    );
    expect(result.reason).toMatch(/invoice\.ts/);
  });

  it('keeps a two-character identifier, which used to be dropped', () => {
    const { identifiers } = namedTokens('extract the `cn` helper into its own file');
    expect(identifiers).toContain('cn');
  });

  it('does not invent an identifier out of an ordinary word', () => {
    // "extract the file" must not name a symbol called `file`; that is the
    // fuzzy-overlap failure this whole branch exists to avoid.
    const { identifiers } = namedTokens('extract the file and update the imports');
    expect(identifiers).toEqual([]);
  });

  it('reads a path however it is written', () => {
    for (const written of [
      'src/lib/billing/invoice.ts',
      './src/lib/billing/invoice.ts',
      '`src/lib/billing/invoice.ts`',
      'edit src/lib/billing/invoice.ts now',
    ]) {
      expect(namedTokens(written).paths).toContain('src/lib/billing/invoice.ts');
    }
  });

  it('ignores a name the repo does not have', () => {
    // An invented symbol is not evidence about where the developer is working.
    const result = classifyPrompt('rework the FlibbertyGibbet handler', index, vendorBoundary);
    expect(result.namedOutside).toEqual([]);
  });

  it('still says SAME when the named file IS the boundary', () => {
    const result = classifyPrompt(
      'in src/lib/vendors/create.ts, also handle the empty-name case',
      index,
      vendorBoundary,
    );
    expect(result.verdict).toBe('SAME');
  });
});

describe('a question is not a task (bug 7)', () => {
  it('recognises the prompt that set a 374-function boundary', () => {
    expect(isQuestion('Where is link expiry enforced?')).toBe(true);
  });

  it('recognises questions without a question mark', () => {
    for (const prompt of [
      'where is duplicate email handling in this codebase',
      'how does the vendor submit flow work',
      'what calls createVendor',
      'is there a toast helper already',
    ]) {
      expect(isQuestion(prompt), prompt).toBe(true);
    }
  });

  it('treats a politely-phrased instruction as work, not curiosity', () => {
    // The expensive mistake is this direction: reading "could you fix X?" as a
    // question leaves Ichor silent through the entire change.
    for (const prompt of [
      'could you fix the duplicate email crash?',
      'can you add a toast when the email already exists?',
      'would you mind refactoring the vendor form?',
      'how about we rename createVendor to addVendor?',
    ]) {
      expect(isQuestion(prompt), prompt).toBe(false);
    }
  });

  it('treats a plain instruction as work', () => {
    for (const prompt of [
      'fix the duplicate email crash in vendor onboarding',
      'add a toast saying the email already exists',
      'now do the billing rounding',
    ]) {
      expect(isQuestion(prompt), prompt).toBe(false);
    }
  });
});

/**
 * Bug 12, from a live session on a 7,741-file monorepo.
 *
 * Every prompt was filed as noise — *"outside matches too scattered (6,453 files) to
 * be a task"* — including ones that named a file outright. The spread guard was
 * counting named paths alongside fuzzy word matches, so one typed filename was
 * buried under thousands of incidental hits and the boundary could never move.
 */
describe('a named file survives a noisy sentence (bug 12)', () => {
  /** A repo where one ordinary word matches almost everything, as on a monorepo. */
  const noisyIndex = buildNameIndex(
    {
      files: Array.from({ length: 400 }, (_, i) => ({
        key: `file:backend/src/services/thing${i}/service.ts`,
        path: `backend/src/services/thing${i}/service.ts`,
      })),
      functions: Array.from({ length: 400 }, (_, i) => ({
        key: `function:backend/src/services/thing${i}/service.ts#serviceHandler${i}`,
        name: `serviceHandler${i}`,
        file: `backend/src/services/thing${i}/service.ts`,
        line: 1,
        exported: true,
        isComponent: false,
        isTest: false,
      })),
      routes: [],
      models: [],
      fields: [],
      types: [],
      calls: [],
      references: [],
      touches: [],
      imports: [],
      stats: {},
    } as unknown as GraphFacts,
    '2026-08-17T00:00:00.000Z',
  );

  const somewhereElse: BoundaryView = {
    names: ['serviceHandler7'],
    files: ['backend/src/services/thing7/service.ts'],
  };

  it('does not bury one typed filename under thousands of incidental matches', () => {
    const result = classifyPrompt(
      'Do it now, no questions: in backend/src/services/thing300/service.ts set the retry attempts to 3. Just make that one edit.',
      noisyIndex,
      somewhereElse,
    );
    // The word "service" alone matches every file here — exactly the condition that
    // made a live session ignore every instruction.
    expect(result.outsideFiles.length).toBeGreaterThan(50);
    expect(result.verdict).not.toBe('NO_SIGNAL');
    expect(result.namedOutside).toContain('backend/src/services/thing300/service.ts');
  });

  it('still refuses a wall of pasted paths, however noisy the words', () => {
    const trace = [
      'it crashed:',
      ...Array.from({ length: 10 }, (_, i) => `    at serviceHandler${i} (backend/src/services/thing${i}/service.ts:3)`),
    ].join('\n');

    const result = classifyPrompt(trace, noisyIndex, somewhereElse);
    expect(result.verdict).toBe('NO_SIGNAL');
    expect(result.reason).toMatch(/scattered/);
  });

  it('treats two or three named files as a statement, not a paste', () => {
    const result = classifyPrompt(
      'update backend/src/services/thing11/service.ts and backend/src/services/thing12/service.ts',
      noisyIndex,
      somewhereElse,
    );
    expect(result.verdict).not.toBe('NO_SIGNAL');
  });
});

/**
 * A named symbol is evidence, and it must outrank noise.
 *
 * These exist because of a live failure on a 1,340-file repository. The spread
 * guard — which is there to stop a boundary moving on scattered word matches —
 * ran BEFORE the named-outright override and exempted only paths. So a prompt
 * naming a real function was thrown away by the generic words sitting next to it,
 * and Ichor spent five consecutive turns policing a task the developer had
 * already moved on from, challenging the very work they had just asked for.
 *
 * Six phrasings of one intent were tried live. Exactly one — the full
 * repo-relative path — moved the boundary.
 */
describe('a named symbol outranks scattered words', () => {
  /** Enough generic words to trip the spread guard on their own. */
  const noisy = 'widget alpha bravo charlie delta echo foxtrot golf hotel india juliet';

  it('moves the boundary when the prompt names a function that exists', () => {
    const verdict = classifyPrompt(
      `different job now, work on \`createInvoice\` ${noisy}`,
      index,
      vendorBoundary,
    );
    expect(verdict.verdict).not.toBe('NO_SIGNAL');
    expect(verdict.namedOutside).toContain('createInvoice');
  });

  it('would have said NO_SIGNAL on those words alone', () => {
    // Proves the words really are scattered enough to trip the guard, so the
    // test above is measuring the override and not a quiet prompt.
    const verdict = classifyPrompt(noisy, index, vendorBoundary);
    expect(verdict.verdict).toBe('NO_SIGNAL');
  });

  it('still moves the boundary for a named path, as it always did', () => {
    const verdict = classifyPrompt(
      `now work on src/lib/billing/invoice.ts ${noisy}`,
      index,
      vendorBoundary,
    );
    expect(verdict.verdict).not.toBe('NO_SIGNAL');
  });

  it('does not invent a switch from a name the repo does not have', () => {
    const verdict = classifyPrompt(
      `now work on \`totallyMadeUpSymbol\` ${noisy}`,
      index,
      vendorBoundary,
    );
    expect(verdict.verdict).toBe('NO_SIGNAL');
  });

  it('treats a wall of names as pasted output, not as a statement', () => {
    // A stack trace names many things. The guard exists for exactly this, and it
    // must still apply now that identifiers count towards it.
    const verdict = classifyPrompt(
      'createInvoice markInvoicePaid listUnpaidInvoices requireSession `alphaWidget` ' +
        '`bravoWidget` `charlieWidget` ' + noisy,
      index,
      vendorBoundary,
    );
    expect(verdict.verdict).toBe('NO_SIGNAL');
    expect(verdict.reason).toMatch(/pasted/);
  });

  it('a symbol already inside the boundary is not a switch', () => {
    const verdict = classifyPrompt('keep going on `createVendor`', index, vendorBoundary);
    expect(verdict.verdict).not.toBe('NEW');
  });
});
