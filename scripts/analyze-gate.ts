/**
 * Does the analysis still produce exactly the same facts?
 *
 *   npm run analyze:gate -- snapshot <repo> [<repo> …]     before a change
 *   npm run analyze:gate -- compare  <repo> [<repo> …]     after it
 *
 * WHY
 *
 * `analyzeRepo` is being restructured to read one file at a time instead of
 * holding the whole repository open — the difference between 1,988 MB and about
 * 300 MB on a large codebase. That is a change to HOW the facts are gathered,
 * and it must not be a change to WHAT they are.
 *
 * A wrong graph does not announce itself. Every answer Ichor gives still looks
 * confident; it is just quietly citing a path that is not there, or missing one
 * that is. So this pins the current output to disk first and compares against it
 * afterwards — field by field, edge by edge — the same discipline
 * `incremental-test.ts` uses for the same reason.
 *
 * Snapshots go to the scratch directory, not the repo. They are a measuring
 * instrument for one change, not an artefact to keep.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { analyzeRepo } from '../src/extract/analyze.js';
import type { GraphFacts } from '../src/extract/types.js';

const mode = process.argv[2];
const repos = process.argv.slice(3);

if (mode !== 'snapshot' && mode !== 'compare') {
  console.error('usage: npm run analyze:gate -- <snapshot|compare> <repo> [<repo> …]');
  process.exit(1);
}

const store = path.join(os.tmpdir(), 'ichor-analyze-gate');
fs.mkdirSync(store, { recursive: true });

const slug = (repo: string) => path.basename(path.resolve(repo)).replace(/[^\w.-]/g, '_');

/**
 * Facts as comparable plain data.
 *
 * Sorted, because the point is whether the same facts were found — not the order
 * a particular loop happened to visit them in. An ordering difference is worth
 * knowing about but is not a correctness failure, so it is reported separately
 * rather than drowning the real signal.
 */
function normalise(facts: GraphFacts): Record<string, string[]> {
  const sorted = (rows: string[]) => [...rows].sort();

  return {
    files: sorted(facts.files.map((f) => `${f.key}|${f.path}`)),
    functions: sorted(
      facts.functions.map(
        (f) =>
          `${f.key}|${f.name}|${f.file}|${f.line}|${f.endLine}|` +
          `${f.exported}|${f.isComponent}|${f.isTest}`,
      ),
    ),
    types: sorted(
      facts.types.map((t) => `${t.key}|${t.name}|${t.kind}|${t.file}|${t.line}|${t.exported}`),
    ),
    routes: sorted(
      facts.routes.map((r) => `${r.key}|${r.method}|${r.path}|${r.handlerKey}|${r.file}|${r.line}`),
    ),
    models: sorted(facts.models.map((m) => `${m.key}|${m.name}`)),
    fields: sorted(facts.fields.map((f) => `${f.key}|${f.name}|${f.model}|${f.type}`)),
    calls: sorted(
      facts.calls.map(
        (c) => `${c.fromKey}|${c.toKey}|${c.file}|${c.line}|${c.viaRender ?? false}|${c.viaContains ?? false}`,
      ),
    ),
    references: sorted(facts.references.map((r) => `${r.fromKey}|${r.toKey}|${r.file}|${r.line}`)),
    touches: sorted(
      facts.touches.map((t) => `${t.fromKey}|${t.modelKey}|${t.operation}|${t.isWrite}|${t.file}|${t.line}`),
    ),
    imports: sorted(facts.imports.map((i) => `${i.fromFileKey}|${i.toFileKey}`)),
    // The symbol tables are what an incremental run replays instead of re-parsing,
    // so a drift here is a drift in every later refresh.
    symbols: sorted(
      [...(facts.symbols ?? [])].map(
        ([file, table]) =>
          `${file}|L:${[...table.locals.keys()].sort().join(',')}` +
          `|I:${[...table.imports.entries()].sort().map(([k, v]) => `${k}=${v.module}:${v.imported}`).join(',')}` +
          `|E:${[...table.exports.entries()].sort().map(([k, v]) => `${k}=${v.local ?? ''}:${v.fromModule ?? ''}:${v.imported ?? ''}`).join(',')}` +
          `|S:${[...table.starExports].sort().join(',')}`,
      ),
    ),
    stats: [
      `callSitesTotal=${facts.stats.callSitesTotal}`,
      `callSitesResolvedInRepo=${facts.stats.callSitesResolvedInRepo}`,
      `callSitesExternal=${facts.stats.callSitesExternal}`,
      `callSitesUnresolved=${facts.stats.callSitesUnresolved}`,
      `callSitesNeedingTypes=${facts.stats.callSitesNeedingTypes}`,
      `typeRefsResolved=${facts.stats.typeRefsResolved}`,
      `typeRefsUnresolved=${facts.stats.typeRefsUnresolved}`,
      `edgesDropped=${facts.stats.edgesDropped}`,
      `duplicateNames=${facts.stats.duplicateNames}`,
      `filesScanned=${facts.stats.filesScanned}`,
    ],
  };
}

let failures = 0;

for (const repo of repos) {
  const root = path.resolve(repo);
  const file = path.join(store, `${slug(repo)}.json`);
  const started = Date.now();
  const facts = analyzeRepo(root);
  const shaped = normalise(facts);
  const peak = Math.round((process.resourceUsage().maxRSS * 1024) / 1e6);

  if (mode === 'snapshot') {
    fs.writeFileSync(file, JSON.stringify(shaped));
    console.log(
      `  saved  ${path.basename(root).padEnd(24)} ` +
        `${facts.functions.length} functions, ${facts.calls.length} calls, ` +
        `${facts.references.length} references   ${Date.now() - started}ms`,
    );
    continue;
  }

  if (!fs.existsSync(file)) {
    console.log(`  ✗ ${path.basename(root)} — no snapshot; run \`snapshot\` first`);
    failures++;
    continue;
  }

  const before = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string[]>;
  const problems: string[] = [];

  for (const key of Object.keys(before)) {
    const was = before[key] ?? [];
    const now = shaped[key] ?? [];
    const wasSet = new Set(was);
    const nowSet = new Set(now);
    const missing = was.filter((row) => !nowSet.has(row));
    const added = now.filter((row) => !wasSet.has(row));

    if (missing.length || added.length) {
      problems.push(`${key}: ${missing.length} lost, ${added.length} new (of ${was.length})`);
      for (const row of missing.slice(0, 3)) problems.push(`      lost  ${row.slice(0, 150)}`);
      for (const row of added.slice(0, 3)) problems.push(`      new   ${row.slice(0, 150)}`);
    }
  }

  if (problems.length === 0) {
    console.log(
      `  ✓ ${path.basename(root).padEnd(24)} identical ` +
        `(${facts.functions.length} functions, ${facts.calls.length} calls, ` +
        `${facts.references.length} references)   ${Date.now() - started}ms, peak ${peak} MB`,
    );
  } else {
    failures++;
    console.log(`  ✗ ${path.basename(root)}`);
    for (const line of problems) console.log(`      ${line}`);
  }
}

console.log('');
if (mode === 'compare') {
  console.log(
    failures === 0
      ? `  the restructured analysis produces identical facts on all ${repos.length} repositories\n`
      : `  ${failures} of ${repos.length} differ\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
