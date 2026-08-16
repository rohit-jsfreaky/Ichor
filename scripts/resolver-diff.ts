/**
 * Prove the resolver did not lose anything.
 *
 *   npx tsx scripts/resolver-diff.ts capture ./demo .            <- before a change
 *   npx tsx scripts/resolver-diff.ts compare ./demo .            <- after it
 *
 * Replacing type-checker resolution with our own symbol tables is the single
 * riskiest change in this codebase: it is fast, and it fails SILENTLY. A missing
 * edge does not throw, it just means Ichor stops seeing a connection and quietly
 * stops challenging things it should. Tests on the demo cannot catch that — the
 * demo is eleven files.
 *
 * So: snapshot every edge the old resolver produced, then diff. Anything lost
 * has to be explainable, and the only acceptable explanation is `obj.method()`
 * on a value whose type only the checker knows.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeRepo } from '../src/extract/analyze.js';

const SNAPSHOT_DIR = path.resolve('.resolver-baseline');

interface Snapshot {
  repo: string;
  calls: string[];
  references: string[];
  routes: string[];
  touches: string[];
  counts: Record<string, number>;
}

function snapshot(repo: string): Snapshot {
  const facts = analyzeRepo(repo);
  return {
    repo,
    calls: facts.calls.map((c) => `${c.fromKey} -> ${c.toKey}`).sort(),
    references: facts.references.map((r) => `${r.fromKey} -> ${r.toKey}`).sort(),
    routes: facts.routes.map((r) => `${r.method} ${r.path} -> ${r.handlerKey}`).sort(),
    touches: facts.touches.map((t) => `${t.fromKey} -> ${t.modelKey}`).sort(),
    counts: {
      files: facts.files.length,
      functions: facts.functions.length,
      types: facts.types.length,
      callSitesTotal: facts.stats.callSitesTotal,
      durationMs: facts.stats.durationMs,
    },
  };
}

const fileFor = (repo: string) =>
  path.join(SNAPSHOT_DIR, `${path.basename(path.resolve(repo))}.json`);

function capture(repos: string[]): void {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const repo of repos) {
    const started = Date.now();
    const snap = snapshot(repo);
    fs.writeFileSync(fileFor(repo), JSON.stringify(snap), 'utf8');
    console.log(
      `  captured ${path.basename(path.resolve(repo)).padEnd(14)} ` +
        `${String(snap.calls.length).padStart(6)} calls  ` +
        `${String(snap.references.length).padStart(5)} refs  ` +
        `${Date.now() - started}ms`,
    );
  }
}

/**
 * Did this edge simply move to a more precise owner?
 *
 * When a constructor, getter or class property becomes visible, an edge that
 * used to hang off the CLASS is re-credited to the member it is really in:
 *
 *   before   type:client.ts#GraphClient             -> type:client.ts#HydraConfig
 *   after    function:client.ts#GraphClient.constructor -> type:client.ts#HydraConfig
 *
 * Nothing was lost there, and calling it a loss would train us to ignore the
 * one signal that protects rule 1. A move is only a move if the destination is
 * identical and the new source is a MEMBER of the old one.
 */
function movedTo(lostEdge: string, gainedSet: Set<string>): string | undefined {
  const [from, to] = lostEdge.split(' -> ');
  if (!to) return undefined;

  const name = from.slice(from.indexOf(':') + 1);
  for (const gained of gainedSet) {
    const [gainedFrom, gainedTo] = gained.split(' -> ');
    if (gainedTo !== to) continue;
    const gainedName = gainedFrom.slice(gainedFrom.indexOf(':') + 1);
    if (gainedName.startsWith(`${name}.`)) return gained;
  }
  return undefined;
}

function diff(label: string, before: string[], after: string[]): boolean {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const gained = after.filter((e) => !beforeSet.has(e));
  const gainedSet = new Set(gained);

  const moved: [string, string][] = [];
  const lost: string[] = [];
  for (const edge of before) {
    if (afterSet.has(edge)) continue;
    const destination = movedTo(edge, gainedSet);
    if (destination) moved.push([edge, destination]);
    else lost.push(edge);
  }

  const mark = lost.length === 0 ? '✓' : '✗';
  console.log(
    `    ${mark} ${label.padEnd(12)} kept ${before.length - lost.length - moved.length}/${before.length}` +
      `${lost.length ? `  LOST ${lost.length}` : ''}` +
      `${moved.length ? `  moved ${moved.length}` : ''}` +
      `${gained.length ? `  gained ${gained.length}` : ''}`,
  );
  for (const e of lost.slice(0, 8)) console.log(`        lost:   ${e}`);
  for (const [from, to] of moved.slice(0, 3)) {
    console.log(`        moved:  ${from}`);
    console.log(`             -> ${to}`);
  }
  for (const e of gained.slice(0, 3)) console.log(`        gained: ${e}`);
  return lost.length === 0;
}

function compare(repos: string[]): void {
  let clean = true;

  for (const repo of repos) {
    const file = fileFor(repo);
    if (!fs.existsSync(file)) {
      console.log(`  no baseline for ${repo} — run capture first`);
      continue;
    }
    const before = JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;

    const started = Date.now();
    const after = snapshot(repo);
    const ms = Date.now() - started;

    console.log(`\n  ${path.basename(path.resolve(repo))}`);
    console.log(
      `    time ${before.counts.durationMs}ms -> ${after.counts.durationMs}ms` +
        `   (${(before.counts.durationMs / Math.max(after.counts.durationMs, 1)).toFixed(1)}x)   wall ${ms}ms`,
    );
    clean = diff('calls', before.calls, after.calls) && clean;
    clean = diff('references', before.references, after.references) && clean;
    clean = diff('routes', before.routes, after.routes) && clean;
    clean = diff('touches', before.touches, after.touches) && clean;
  }

  console.log('');
  console.log(clean ? '  no edges lost.' : '  EDGES LOST — every one must be explained before shipping.');
  if (!clean) process.exitCode = 1;
}

const [mode, ...repos] = process.argv.slice(2);
if (mode !== 'capture' && mode !== 'compare') {
  console.log('usage: resolver-diff.ts capture|compare <repo...>');
  process.exit(1);
}
if (repos.length === 0) repos.push('./demo', '.');

console.log(`\n${mode === 'capture' ? 'Capturing baseline' : 'Comparing against baseline'}\n`);
if (mode === 'capture') capture(repos);
else compare(repos);
console.log('');
