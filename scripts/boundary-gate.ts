/**
 * Does the boundary come out identical after the walk was rewritten?
 *
 *   tsx scripts/boundary-gate.ts snapshot <repo> [<task> …]     before a change
 *   tsx scripts/boundary-gate.ts compare  <repo> [<task> …]     after it
 *
 * WHY
 *
 * The boundary decides which edits get challenged, so a subtly different one is
 * invisible until it is wrong. Any change to how the walk is computed has to prove
 * the answer is unchanged — members, distances and the REASON each member carries,
 * because the reason is what a developer reads in a challenge.
 *
 * This is what caught the one-query walk being a dead end. Both paths drew
 * byte-identical boundaries, so the rewrite was correct; it was then measured and
 * lost on both axes, and knowing it was correct is what made discarding it a
 * decision rather than a retreat. See the note above `Row` in neighborhood.ts.
 *
 * Several tasks per run, because a boundary is task-shaped and one of them would
 * only prove the walk works for one shape of question.
 *
 * Invoked through `tsx` directly, NOT `npm run`: npm reflows quoted arguments, so
 * a multi-word task arrives as several, and snapshot and compare then key their
 * results differently and silently compare nothing.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { analyzeRepo } from '../src/extract/analyze.js';
import { writeGraph } from '../src/graph/write.js';
import { GraphClient, configFromEnv } from '../src/graph/client.js';
import { loadFacts } from '../src/refresh/refresh.js';
import { findAnchors } from '../src/scope/anchors.js';
import { buildNeighborhood } from '../src/scope/neighborhood.js';

const mode = process.argv[2];
const repo = path.resolve(process.argv[3] ?? './demo');
const tasks = process.argv.slice(4);

if (mode !== 'snapshot' && mode !== 'compare') {
  console.error('usage: tsx scripts/boundary-gate.ts <snapshot|compare> <repo> [<task> …]');
  process.exit(1);
}

/** Enough shapes of question that one lucky pass cannot carry the result. */
const DEFAULT_TASKS = [
  'Duplicate email in vendor onboarding currently returns 500. Handle the duplicate-email case properly and show a toast.',
  'the billing invoice rounding is wrong',
  'add a session timeout to the auth flow',
  'rename createVendor to addVendor everywhere',
];

const store = path.join(os.tmpdir(), 'ichor-boundary-gate');
fs.mkdirSync(store, { recursive: true });
const file = path.join(store, `${path.basename(repo).replace(/[^\w.-]/g, '_')}.json`);

const client = new GraphClient(configFromEnv());

// The graph has to hold this repo before anything is asked of it. `alarms` in
// ground-truth.ts assumed a populated database and, run after a wipe, reported a
// confident 84.9% measured against nothing.
//
// The edge ledger is passed in so this takes the DELTA path. Without it the write
// upserts all 21,304 edges, which is the slow path bug 1 was about — and on a
// database holding several projects it exceeds the 30-second statement ceiling, so
// the gate would die in its own setup and look like a failure of the walk.
const facts = loadFacts(repo) ?? analyzeRepo(repo);
const ledger = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, '.ichor', 'incremental.json'), 'utf8')).edges;
  } catch {
    return undefined;
  }
})();
const wrote = await writeGraph(client, facts, {
  previous: facts,
  previousEdges: ledger,
  onProgress: (m) => console.log(`    write: ${m}`),
});
console.log(`\n  graph: ${wrote.edgesWritten} edges written (${(wrote.durationMs / 1000).toFixed(1)}s)`);

const shaped: Record<string, string[]> = {};
const timings: string[] = [];

for (const task of tasks.length ? tasks : DEFAULT_TASKS) {
  const { anchors, terms } = findAnchors(facts, task);
  const started = Date.now();
  const neighborhood = await buildNeighborhood(client, task, anchors, terms);
  const ms = Date.now() - started;

  // Members with their distance AND reason. The reason is what a developer reads
  // in a challenge, so a walk that finds the same functions by a different route
  // is not the same walk.
  shaped[task] = [...neighborhood.members.values()]
    .map((m) => `${m.name}|${m.file}|${m.distance}|${m.reason}`)
    .sort();
  shaped[`${task} ::models`] = [...neighborhood.coreModels].sort();

  timings.push(
    `    ${neighborhood.members.size} members, ${neighborhood.stats.queryCount} queries, ${ms}ms` +
      `   ${task.slice(0, 44)}`,
  );
}



console.log(`\n${repo}`);
for (const line of timings) console.log(line);

await client.close();

if (mode === 'snapshot') {
  fs.writeFileSync(file, JSON.stringify(shaped));
  console.log(`\n  saved ${Object.keys(shaped).length / 2} boundaries\n`);
  process.exit(0);
}

if (!fs.existsSync(file)) {
  console.log('\n  ✗ no snapshot; run `snapshot` first\n');
  process.exit(1);
}

const before = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string[]>;
let bad = 0;

console.log('');
for (const key of Object.keys(before)) {
  const was = new Set(before[key] ?? []);
  const now = new Set(shaped[key] ?? []);
  const lost = [...was].filter((row) => !now.has(row));
  const gained = [...now].filter((row) => !was.has(row));

  if (lost.length === 0 && gained.length === 0) {
    console.log(`  ✓ ${key.slice(0, 60)}  (${was.size})`);
    continue;
  }
  bad++;
  console.log(`  ✗ ${key.slice(0, 60)}  ${lost.length} lost, ${gained.length} new (of ${was.size})`);
  for (const row of lost.slice(0, 4)) console.log(`      lost  ${row}`);
  for (const row of gained.slice(0, 4)) console.log(`      new   ${row}`);
}

console.log(
  bad === 0
    ? '\n  the rewritten walk draws an identical boundary\n'
    : `\n  ${bad} boundaries differ\n`,
);
process.exitCode = bad === 0 ? 0 : 1;
