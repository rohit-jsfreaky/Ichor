/**
 * Does seeding from a named file narrow a small task without touching a large one?
 *
 * Bug 15: asked to add one comment to one file, Ichor anchored across 91 files.
 * The fix seeds from the file the prompt named. That is a claim with two halves,
 * and only measuring both makes it a fix rather than a preference:
 *
 *   1. a prompt that names a file must anchor inside it — narrower, provably
 *   2. a prompt that names nothing must be COMPLETELY unchanged, anchor for anchor
 *
 * Half two is the one that matters. Commit messages almost never name a path, so
 * the 30-commit ground-truth number cannot detect a regression here; if this
 * quietly altered the no-name path, the published false-alarm rate would be
 * measuring different code than the one that shipped.
 *
 * Runs against cached facts from a real repository — no database, no network.
 *
 *   npx tsx scripts/named-seed-gate.ts <repo>
 */

import fs from 'node:fs';
import path from 'node:path';

import { findAnchors } from '../src/scope/anchors.js';
import { loadFacts } from '../src/refresh/refresh.js';

const repo = process.argv[2];
if (!repo) {
  console.error('usage: npx tsx scripts/named-seed-gate.ts <repo>');
  process.exit(2);
}

// The same reader the hook uses, envelope and all — parsing the cache by hand
// here is how a gate ends up measuring a shape the product does not have.
const facts = loadFacts(repo);
if (!facts) {
  console.error(`no readable facts cache in ${repo} — run \`ichor start\` there first`);
  process.exit(2);
}
console.log(`${path.basename(repo)}: ${facts.files.length} files, ${facts.functions.length} functions\n`);

/**
 * A real file from this repo, holding several declarations and with a basename
 * unique across the repo.
 *
 * Both conditions earn their place. A single-declaration file passed the "all
 * anchors inside the named file" assertion without ever exercising the rule that
 * every declaration in it is seeded. A duplicated basename is rejected by
 * `namedFiles` as ambiguous, so the bare-name case would silently test the
 * fallback path while appearing to test seeding.
 */
const perFile = new Map<string, number>();
for (const fn of facts.functions) perFile.set(fn.file, (perFile.get(fn.file) ?? 0) + 1);

const basenameCounts = new Map<string, number>();
for (const p of perFile.keys()) {
  const b = path.basename(p).toLowerCase();
  basenameCounts.set(b, (basenameCounts.get(b) ?? 0) + 1);
}

const namedTarget = [...perFile.entries()]
  .filter(([p, n]) => n >= 5 && basenameCounts.get(path.basename(p).toLowerCase()) === 1)
  .sort((a, b) => b[1] - a[1])[0]?.[0];

if (!namedTarget) {
  console.error('no unambiguous multi-declaration file in this repo to test with');
  process.exit(2);
}
const declarations = perFile.get(namedTarget)!;
const base = path.basename(namedTarget);
console.log(`naming: ${namedTarget} (${declarations} declarations)
`);

interface Case {
  label: string;
  prompt: string;
  /** Anchors must all sit in this file when seeding is on. */
  expectWithin?: string;
}

const cases: Case[] = [
  {
    label: 'names a file, bare name',
    prompt: `add a comment explaining the retry logic in ${base}`,
    expectWithin: namedTarget,
  },
  {
    label: 'names a file, full path',
    prompt: `fix the error handling in ${namedTarget}`,
    expectWithin: namedTarget,
  },
  // No path named — the ordinary route, and the one that must not move.
  { label: 'names nothing (feature words)', prompt: 'fix duplicate email handling in vendor onboarding' },
  { label: 'names nothing (broad)', prompt: 'rework the reminder pipeline so it batches sends' },
  { label: 'names nothing (quoted copy)', prompt: 'the message says "Link has expired" — make it friendlier' },
  { label: 'names nothing (one word)', prompt: 'branding' },
  // A path that does not exist must fall back rather than empty the boundary.
  { label: 'names a file that is not here', prompt: 'update src/does/not/exist.ts to add a guard' },
  // A name matching many files is not a pointer.
  { label: 'names an ambiguous file', prompt: 'update index.ts to export the new helper' },
];

let failures = 0;

for (const c of cases) {
  const off = findAnchors(facts, c.prompt, { namedFileSeeding: false });
  const on = findAnchors(facts, c.prompt, { namedFileSeeding: true });

  const filesOff = new Set(off.anchors.map((a) => a.file).filter(Boolean)).size;
  const filesOn = new Set(on.anchors.map((a) => a.file).filter(Boolean)).size;

  if (c.expectWithin) {
    const strays = on.anchors.filter((a) => a.file && a.file !== c.expectWithin);
    const narrowed = filesOn < filesOff;
    // The whole file, not just the word that matched — the point of the fix.
    const wholeFile = on.anchors.length === Math.min(declarations, 60);
    const ok = strays.length === 0 && on.anchors.length > 0 && narrowed && wholeFile;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${c.label}\n` +
        `        ${off.anchors.length} anchors / ${filesOff} files  ->  ` +
        `${on.anchors.length} anchors / ${filesOn} files` +
        (strays.length ? `\n        ${strays.length} anchor(s) outside the named file` : '') +
        (on.anchors.length === 0 ? '\n        seeding emptied the boundary' : '') +
        (!narrowed ? '\n        did not narrow' : ''),
    );
    continue;
  }

  // Identical, not merely similar. Same keys in the same order with the same scores.
  const key = (r: typeof on) => r.anchors.map((a) => `${a.key}@${a.score.toFixed(6)}`).join('|');
  const same = key(off) === key(on);
  if (!same) failures++;
  console.log(
    `${same ? 'PASS' : 'FAIL'}  ${c.label}\n` +
      `        ${off.anchors.length} anchors / ${filesOff} files — unchanged: ${same}`,
  );
}

/**
 * The 30 real commits, which are what the published false-alarm rate is measured on.
 *
 * This is the check that decided whether the fix was allowed to ship. If a single
 * one of those commits produces a different anchor set, the boundary changed for a
 * case inside the published measurement — so the number in the README describes
 * code that no longer exists, and it has to be re-run end to end (slow, and it
 * needs a loaded database).
 *
 * If they are all identical, the number provably cannot have moved: the same
 * anchors in means the same boundary and the same verdicts out. That is a stronger
 * statement than the re-run gives, and it costs a second rather than half an hour.
 */
const casesFile = path.resolve('.ground-truth/cases.json');
if (fs.existsSync(casesFile)) {
  const commits = JSON.parse(fs.readFileSync(casesFile, 'utf8')) as { sha: string; task: string }[];
  const anchorKey = (r: ReturnType<typeof findAnchors>) =>
    r.anchors.map((a) => `${a.key}@${a.score.toFixed(6)}`).join('|');

  const moved = commits.filter(
    (c) =>
      anchorKey(findAnchors(facts, c.task, { namedFileSeeding: false })) !==
      anchorKey(findAnchors(facts, c.task, { namedFileSeeding: true })),
  );

  if (moved.length > 0) failures++;
  console.log(
    `\n${moved.length === 0 ? 'PASS' : 'FAIL'}  the ${commits.length} ground-truth commits are unchanged\n` +
      (moved.length === 0
        ? '        anchor sets identical, so the published false-alarm rate cannot have moved'
        : `        ${moved.length} moved — the published rate must be re-measured:` +
          moved.map((c) => `\n        ${c.sha.slice(0, 8)} ${c.task.slice(0, 70)}`).join('')),
  );
} else {
  console.log(`\nSKIP  no .ground-truth/cases.json — cannot check the published rate`);
}

console.log(`\n${failures === 0 ? 'named-seed gate: PASS' : `named-seed gate: FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
