/**
 * Two projects in one database must not bleed into each other.
 *
 *   npx tsx scripts/multi-repo-test.ts <repoA> <repoB>
 *
 * Both fixtures deliberately contain a `src/lib/db.ts` declaring `connect`, and
 * a Prisma model called `User`. Before repo-scoped keys those were byte-identical
 * node keys, so the two projects merged into one graph: `connect` in project A
 * and `connect` in project B became a single node, and every edge either project
 * had was attributed to both. That is the failure this file exists to catch, and
 * it is a silent one — the merged graph answers confidently and wrongly.
 *
 * Checked here:
 *   1. the same path in two projects is two nodes
 *   2. writing the second project does not delete or alter the first
 *   3. a boundary drawn in one project contains nothing from the other
 *   4. asking who calls a name present in BOTH answers for one project only
 *   5. an edit in one project is never justified by the other's code
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeRepo } from '../src/extract/analyze.js';
import { writeGraph } from '../src/graph/write.js';
import { GraphClient, configFromEnv } from '../src/graph/client.js';
import { findAnchors } from '../src/scope/anchors.js';
import { buildNeighborhood } from '../src/scope/neighborhood.js';
import { classify } from '../src/scope/classify.js';
import { callersOf } from '../src/graph/queries.js';
import { repoIdFor } from '../src/ids.js';

/**
 * The fixtures are written to a temp directory rather than kept in the repo.
 *
 * They have to contain a Prisma schema declaring `User` to be a real test, and
 * anything with a `.prisma` file inside this repository gets picked up when
 * Ichor analyses ITSELF — which would put a second `User` model into our own
 * graph and quietly corrupt every other suite.
 */
function writeTwins(): [string, string] {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ichor-twins-'));
  const tsconfig = JSON.stringify(
    { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true }, include: ['src'] },
    null,
    2,
  );
  // Same file path, same function name, same model name in both. That identity
  // is the whole point: it is exactly what used to merge into one node.
  const schema = 'model User {\n  id    String @id\n  email String @unique\n}\n';

  const make = (name: string, flavour: string, second: string, secondBody: string) => {
    const root = path.join(base, name);
    fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tsconfig.json'), tsconfig);
    fs.writeFileSync(path.join(root, 'prisma/schema.prisma'), schema);
    fs.writeFileSync(
      path.join(root, 'src/lib/db.ts'),
      `export function connect(): string { return '${flavour}-db'; }\n` +
        `export function ${flavour}OnlyHelper(): string { return connect(); }\n`,
    );
    fs.writeFileSync(
      path.join(root, `src/lib/${second}.ts`),
      `import { connect } from './db';\nexport function ${secondBody}(): string { return connect(); }\n`,
    );
    return root;
  };

  return [
    make('twin-a', 'alpha', 'orders', 'placeAlphaOrder'),
    make('twin-b', 'beta', 'shipping', 'shipBetaParcel'),
  ];
}

const [argA, argB] = process.argv.slice(2);
const [repoA, repoB] = argA && argB
  ? [path.resolve(argA), path.resolve(argB)]
  : writeTwins();

let passed = 0;
let total = 0;

function check(label: string, ok: boolean, detail = ''): void {
  total++;
  if (ok) passed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const client = new GraphClient(configFromEnv());

try {
  const factsA = analyzeRepo(repoA);
  const factsB = analyzeRepo(repoB);

  // Both projects really do collide on the things that used to merge.
  const sharedFile = 'src/lib/db.ts';
  const aConnect = factsA.functions.find((f) => f.file === sharedFile && f.name === 'connect');
  const bConnect = factsB.functions.find((f) => f.file === sharedFile && f.name === 'connect');

  console.log('\n  the fixtures collide on purpose');
  check('both declare src/lib/db.ts#connect', Boolean(aConnect && bConnect));
  check('both declare a User model', Boolean(
    factsA.models.some((m) => m.name === 'User') && factsB.models.some((m) => m.name === 'User'),
  ));

  console.log('\n  keys and ids stay apart');
  check('the same path is two different keys', aConnect!.key !== bConnect!.key,
    `${aConnect!.key.split('|')[0]} vs ${bConnect!.key.split('|')[0]}`);
  check(
    'the same model name is two different keys',
    factsA.models.find((m) => m.name === 'User')!.key !== factsB.models.find((m) => m.name === 'User')!.key,
  );

  // ---- both projects in one database ------------------------------------
  await writeGraph(client, factsA);
  const afterA = await client.run(
    `MATCH (f:Function {repo: $repo}) RETURN f.id AS id`,
    { repo: repoIdFor(repoA) },
  );
  await writeGraph(client, factsB);

  console.log('\n  writing the second project leaves the first intact');
  const stillA = await client.run(
    `MATCH (f:Function {repo: $repo}) RETURN f.id AS id`,
    { repo: repoIdFor(repoA) },
  );
  check(
    'project A still has all its functions',
    stillA.records.length === afterA.records.length && afterA.records.length > 0,
    `${afterA.records.length} before, ${stillA.records.length} after`,
  );
  const bothLoaded = await client.run(`MATCH (f:Function) RETURN f.id AS id`);
  check(
    'the database holds both projects at once',
    bothLoaded.records.length > stillA.records.length,
    `${bothLoaded.records.length} functions across both`,
  );

  // ---- a boundary in one project sees only that project -----------------
  console.log('\n  a task boundary stays inside its own project');
  const taskA = 'fix the alpha order placement';
  const anchorsA = findAnchors(factsA, taskA);
  const hoodA = await buildNeighborhood(client, taskA, anchorsA.anchors, anchorsA.terms);
  const filesA = new Set(factsA.files.map((f) => f.path));
  const foreign = [...hoodA.members.values()].filter(
    (m) => m.name.includes('Beta') || m.name.includes('beta'),
  );
  check('boundary contains no code from the other project', foreign.length === 0,
    foreign.length ? foreign.map((f) => f.name).join(', ') : `${hoodA.members.size} members`);
  void filesA;

  // ---- the query that seeds by bare name --------------------------------
  console.log('\n  asking who calls a name that exists in BOTH');
  const callersA = await callersOf(client, 'connect', repoIdFor(repoA));
  const callersB = await callersOf(client, 'connect', repoIdFor(repoB));
  const namesA = callersA.callers.map((c) => c.name).join(', ');
  const namesB = callersB.callers.map((c) => c.name).join(', ');
  check('project A answers with A callers only', !/[Bb]eta/.test(namesA), namesA || '(none)');
  check('project B answers with B callers only', !/[Aa]lpha/.test(namesB), namesB || '(none)');

  // ---- a challenge never cites the other project ------------------------
  console.log('\n  a verdict never cites the other project');
  const verdict = await classify(
    { operation: 'edit', file: 'src/lib/shipping.ts' },
    { client, neighborhood: hoodA, repo: repoIdFor(repoA) },
  );
  const cited = [verdict.reason, ...verdict.evidence.map((e) => e.text)].join(' ');
  check(
    'editing B\'s file during A\'s task cites nothing from B',
    !/[Bb]eta/.test(cited),
    verdict.decision,
  );
} finally {
  await client.close();
}

console.log(`\n${passed}/${total} multi-project checks passed\n`);
if (passed !== total) process.exitCode = 1;
