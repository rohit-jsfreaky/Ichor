/**
 * Does a delta write leave the same graph a full write would?
 *
 *   npx tsx scripts/verify-delta.ts <repo>
 *
 * Speed was the easy half of Phase 1. The dangerous failure is silent: a delta
 * that skips an edge which should exist, or writes one twice, leaves Ichor
 * citing a path that is wrong — and every answer still looks confident.
 *
 * Two things are checked, and they are different questions:
 *
 *   the GRAPH  matches what the code says it should hold
 *   the LEDGER matches the graph, because the NEXT delta is computed from it —
 *              a ledger that has drifted quietly corrupts every future write
 *
 * Edges are counted DISTINCT by derived id, not by row: `edge:CALLS:a->b` is one
 * relationship however many call sites produced it. Counting rows here reported
 * 9,790 CALLS against a correct graph holding 7,329.
 */
import * as fs from 'node:fs';
import { GraphClient, configFromEnv, gInt } from '../src/graph/client.js';
import { IdRegistry, repoIdFor } from '../src/ids.js';

const repo = (process.argv[2] ?? 'D:/my_projects/papermark').split('\\').join('/');
const facts = JSON.parse(fs.readFileSync(`${repo}/.ichor/facts.json`, 'utf8')).facts;
const ledger: Record<string, string> =
  JSON.parse(fs.readFileSync(`${repo}/.ichor/incremental.json`, 'utf8')).edges ?? {};
const repoId = repoIdFor(facts.repoRoot);

/** Distinct edges the code implies, per label — the same keys `write.ts` derives. */
const want = new Map<string, Set<string>>();
const add = (label: string, from: string, to: string) => {
  const set = want.get(label) ?? want.set(label, new Set()).get(label)!;
  set.add(`${from}->${to}`);
};

const typeKeys = new Set(facts.types.map((t: any) => t.key));
const modelByName = new Map(facts.models.map((m: any) => [m.name, m.key]));
const fileByPath = new Map(facts.files.map((f: any) => [f.path, f.key]));

for (const c of facts.calls) add('CALLS', c.fromKey, c.toKey);
for (const t of facts.touches) add('TOUCHES', t.fromKey, t.modelKey);
for (const r of facts.routes) add('HANDLED_BY', r.key, r.handlerKey);
for (const f of facts.fields) {
  const m = modelByName.get(f.model);
  if (m) add('HAS_FIELD', m as string, f.key);
}
for (const i of facts.imports) add('IMPORTS', i.fromFileKey, i.toFileKey);
for (const r of facts.references) add('REFERENCES', r.fromKey, r.toKey);
// Functions, types AND models: a Prisma schema declares its models, which is what
// lets a schema edit be judged rather than challenged (Phase 3). Leaving models out
// here reported the graph as 78 edges too many when it was exactly right.
for (const item of [...facts.functions, ...facts.types, ...facts.models]) {
  const file = fileByPath.get(item.file);
  if (file) add('DECLARES', file as string, item.key);
}

const client = new GraphClient(configFromEnv());
let bad = 0;
console.log(`\n${repo}\n`);

/**
 * The labels an edge of each type can start from.
 *
 * The source pattern MUST carry a label. `MATCH (a {repo: $repo})-[:CALLS]->(b)`
 * is unbound, so the engine scans every node of every label — fine on one
 * project, a 30-second timeout once four are loaded. Naming the label is the
 * difference between a bounded lookup and a full scan, the same lesson as
 * "a property filter belongs in the pattern".
 */
const SOURCES: Record<string, string[]> = {
  CALLS: ['Function'],
  TOUCHES: ['Function'],
  HANDLED_BY: ['Route'],
  HAS_FIELD: ['Model'],
  IMPORTS: ['File'],
  DECLARES: ['File'],
  // A type mention inside a function body starts at a Function; one inside an
  // interface body starts at a Type. Both are real, and both have to be counted.
  REFERENCES: ['Function', 'Type'],
};

let unreadable = 0;

for (const [label, set] of [...want].sort()) {
  let got = 0;
  let failed = '';
  for (const from of SOURCES[label] ?? ['Function']) {
    try {
      // count(*), never count(e) — this engine rejects an aggregate over a named
      // variable and reports it as a property-value error.
      const r = await client.run(
        `MATCH (a:${from} {repo: $repo})-[e:${label}]->(b) RETURN count(*) AS n`,
        { repo: repoId },
      );
      got += Number(r.records[0]?.get('n') ?? 0);
    } catch (error) {
      failed = (error as Error).message.split(';')[0];
    }
  }

  // Counting is not free on this engine, and past roughly three projects in one
  // database it exceeds the 30-second statement ceiling — the same wall bug 8
  // describes. Reported as UNKNOWN, never as a pass: a check that cannot run has
  // not told you anything (rule 2).
  if (failed) {
    unreadable++;
    console.log(`  ? ${label.padEnd(12)} could not be counted — ${failed}`);
    continue;
  }

  const ok = got === set.size;
  if (!ok) bad++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${label.padEnd(12)} graph ${String(got).padStart(6)}   code ${String(set.size).padStart(6)}` +
      (ok ? '' : `   <- off by ${got - set.size}`),
  );
}

const total = [...want.values()].reduce((n, s) => n + s.size, 0);
const size = Object.keys(ledger).length;
const ledgerOk = size === total;
if (!ledgerOk) bad++;
console.log(
  `\n  ${ledgerOk ? '✓' : '✗'} ledger ${size} vs code ${total}` +
    (ledgerOk ? '' : '   <- the next delta would be computed against a wrong record'),
);

/**
 * Can the writer still tell an id that exists from one that cannot?
 *
 * This asks about the probe behind `isRepoEmpty`, which decides whether to trust
 * the local edge ledger. It is checked here, against a real database, because it
 * cannot be checked anywhere else — and because it was WRONG for the whole life of
 * the project without one test noticing.
 *
 * The probe used to omit the node label, and on this engine an unlabelled pattern
 * carrying an id does not match a node, it echoes the id back. So it answered
 * "this repo is present" for every id ever passed to it, the ledger was trusted
 * unconditionally, and `ichor down --wipe` followed by a rebuild left a graph with
 * **zero edges against a ledger claiming 21,384** — silently, because a wrong
 * answer of the right shape is indistinguishable from a right one.
 *
 * Two assertions, and the second is the one that matters: finding a real id proves
 * the query works at all, and NOT finding an impossible one proves it is a match
 * rather than an echo.
 */
{
  const realId = gInt(new IdRegistry().idFor(facts.files[0]!.key));
  const impossibleId = gInt(4);

  const found = async (id: ReturnType<typeof gInt>) =>
    (await client.run('MATCH (n:File {id: $id}) RETURN n.id AS id LIMIT 1', { id })).records.length;

  const realFound = await found(realId);
  const fakeFound = await found(impossibleId);
  const probeOk = realFound === 1 && fakeFound === 0;
  if (!probeOk) bad++;

  console.log(
    `  ${probeOk ? '✓' : '✗'} the empty-repo probe distinguishes a real id from an impossible one` +
      (probeOk
        ? ''
        : `\n      a real id returned ${realFound} and an impossible one returned ${fakeFound}` +
          '\n      <- the ledger is being trusted without being verified'),
  );
}

await client.close();

if (bad > 0) {
  console.log(`\n${bad} mismatches\n`);
} else if (unreadable > 0) {
  console.log(
    `\n${unreadable} relationship types could not be counted, so this run proves nothing about them.` +
      '\nRun against a database holding fewer projects — `ichor down --wipe && ichor up`.\n',
  );
} else {
  console.log('\nthe delta write left the graph correct\n');
}
process.exitCode = bad === 0 && unreadable === 0 ? 0 : 1;
