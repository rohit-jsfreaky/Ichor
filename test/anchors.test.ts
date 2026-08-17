/**
 * Seeding a boundary from the file the prompt named (bug 15).
 *
 * Asked to add one comment to one file, Ichor anchored across 91 files and 179
 * functions. The agent reading that briefing said the list "reads like a keyword
 * expansion on service / email / smtp, not the scope of the quoted task", and it
 * was right: scoring has no notion of how big a task is, so a small job in a large
 * repo got a boundary sized by the repo.
 *
 * A developer who types a path has already answered the question the scorer is
 * guessing at. These tests pin both halves of that:
 *
 *   - naming a file restricts the seeds to it, and to ALL of it
 *   - naming nothing, or naming something ambiguous or absent, changes NOTHING
 *
 * The second half is the one worth having. Every anchor-scoring rule in this
 * project was tuned against 30 real commits, and a change that quietly altered
 * the no-name path would invalidate that measurement without failing anything.
 * `scripts/named-seed-gate.ts` checks the same property against a real 1,378-file
 * repository and against those 30 commits directly.
 */

import { describe, expect, it } from 'vitest';

import { findAnchors } from '../src/scope/anchors.js';
import type { GraphFacts } from '../src/extract/types.js';

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
    // The named-file target: several declarations, only one of which matches a
    // task word. Seeding must take all of them.
    fn('sendReminder', 'src/lib/mail/reminder.ts'),
    fn('formatBody', 'src/lib/mail/reminder.ts'),
    fn('backoff', 'src/lib/mail/reminder.ts'),
    fn('recipientsFor', 'src/lib/mail/reminder.ts'),
    // A file with a basename unique in this repo, for the bare-name case.
    fn('buildDigest', 'src/lib/mail/digest.ts'),
    fn('digestSubject', 'src/lib/mail/digest.ts'),
    fn('groupByVendor', 'src/lib/mail/digest.ts'),
    // Elsewhere, matching the same words — what a keyword expansion would drag in.
    fn('sendVendorReminder', 'src/lib/vendors/notify.ts'),
    fn('ReminderBanner', 'src/components/ReminderBanner.tsx'),
    fn('reminderSettings', 'src/lib/settings/reminder.ts'),
    fn('createVendor', 'src/lib/vendors/create.ts'),
    fn('requireSession', 'src/lib/auth/session.ts'),
    // Two files sharing a basename, so `index.ts` is ambiguous on purpose.
    fn('alphaEntry', 'src/lib/alpha/index.ts'),
    fn('bravoEntry', 'src/lib/bravo/index.ts'),
  ];

  const files = [...new Set(functions.map((f) => f.file))].map((path) => ({
    key: `file:${path}`,
    path,
  }));

  return {
    repoRoot: '/repo',
    files,
    functions,
    routes: [],
    models: [{ key: 'model:Vendor', name: 'Vendor' }],
    fields: [
      { key: 'field:Vendor.email', model: 'Vendor', name: 'email', type: 'String', isUnique: true, isId: false },
    ],
    types: [],
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

const facts = fixtureFacts();
const NAMED = 'src/lib/mail/reminder.ts';

/** Same anchors, same order, same scores — not merely a similar-looking set. */
const signature = (task: string, namedFileSeeding: boolean) =>
  findAnchors(facts, task, { namedFileSeeding })
    .anchors.map((a) => `${a.key}@${a.score.toFixed(6)}`)
    .join('|');

describe('a prompt that names a file (bug 15)', () => {
  it('seeds only from that file, by full path', () => {
    const { anchors } = findAnchors(facts, `add a comment to ${NAMED} explaining the retry`);
    expect(anchors.length).toBeGreaterThan(0);
    expect([...new Set(anchors.map((a) => a.file))]).toEqual([NAMED]);
  });

  it('seeds only from that file, by bare filename when it is unique', () => {
    const { anchors } = findAnchors(facts, 'add a comment to digest.ts explaining the grouping');
    expect(anchors.length).toBeGreaterThan(0);
    expect([...new Set(anchors.map((a) => a.file))]).toEqual(['src/lib/mail/digest.ts']);
  });

  it('narrows what a keyword expansion would have reached', () => {
    const task = `add a comment to ${NAMED} explaining the reminder retry`;
    const wide = findAnchors(facts, task, { namedFileSeeding: false });
    const narrow = findAnchors(facts, task, { namedFileSeeding: true });

    // The wide answer reaches other files on the word "reminder" alone. That is
    // the 91-file boundary in miniature.
    expect(new Set(wide.anchors.map((a) => a.file)).size).toBeGreaterThan(1);
    expect(new Set(narrow.anchors.map((a) => a.file)).size).toBe(1);
  });

  it('seeds EVERY declaration in the file, not just the word that matched', () => {
    // Seeding only the term-matching anchors was wrong in the more dangerous
    // direction: "comment explaining the retry" matches one function, so the
    // boundary would become one function and its neighbours — and a boundary that
    // is too NARROW challenges more, not less. Ichor would then argue with the
    // developer about the file they had just named.
    const { anchors } = findAnchors(facts, `add a comment to ${NAMED}`);
    const seeded = new Set(anchors.map((a) => a.name));
    for (const name of ['sendReminder', 'formatBody', 'backoff', 'recipientsFor']) {
      expect(seeded).toContain(name);
    }
  });

  it('says in the reason that the task named the file', () => {
    const { anchors } = findAnchors(facts, `add a comment to ${NAMED}`);
    // Rule 2: never fail silently, and never assert without saying why.
    expect(anchors.every((a) => a.why.includes(NAMED))).toBe(true);
  });
});

describe('a prompt that does not name a usable file', () => {
  it('is completely unchanged when no file is named', () => {
    for (const task of [
      'fix duplicate email handling in vendor onboarding',
      'rework the reminder pipeline so it batches sends',
      'the message says "Link has expired" — make it friendlier',
      'branding',
    ]) {
      expect(signature(task, true)).toBe(signature(task, false));
    }
  });

  it('falls back when the named file is not in the repo', () => {
    // A stale or mistyped path must not empty the boundary. An empty boundary
    // challenges everything, which is the worst outcome available.
    const task = 'update src/does/not/exist.ts to add a guard on reminder sends';
    expect(signature(task, true)).toBe(signature(task, false));
    expect(findAnchors(facts, task).anchors.length).toBeGreaterThan(0);
  });

  it('falls back when a bare filename is not unique', () => {
    // `reminder.ts` is both the mail one and the settings one. Nothing in the
    // prompt says which, so this is not a pointer — and seeding from both would
    // put a file the developer never mentioned at the centre of the boundary.
    const task = 'add a comment to reminder.ts explaining the retry';
    expect(signature(task, true)).toBe(signature(task, false));
  });

  it('falls back on a bare name that resolves to only a couple of files', () => {
    // The case a simple limit lets through, and the one a test caught: `index.ts`
    // matches exactly two files here, which is under any sane cap, and is still
    // completely ambiguous. On a real repo it matches hundreds.
    const task = 'update index.ts to export the reminder helper';
    expect(signature(task, true)).toBe(signature(task, false));
  });

  it('still accepts a path with directories that resolves to a few files', () => {
    // A monorepo with parallel packages: the directories ARE the disambiguation,
    // so this must NOT be lumped in with the ambiguous cases above.
    const { anchors } = findAnchors(facts, 'fix the retry in lib/mail/reminder.ts');
    expect([...new Set(anchors.map((a) => a.file))]).toEqual([NAMED]);
  });
});
