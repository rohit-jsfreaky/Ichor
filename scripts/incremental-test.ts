/**
 * An incremental read must equal a full read. Exactly.
 *
 *   npx tsx scripts/incremental-test.ts [repo]
 *
 * This is the only thing that makes re-reading part of a codebase safe. A stale
 * graph does not announce itself — every answer still looks confident, and the
 * boundary it draws is wrong in ways nobody notices until Ichor stays silent on
 * something it should have questioned.
 *
 * So the test is equality of the whole result, not a spot check: every function,
 * every call, every reference, every model touch. The repository is copied first
 * and edited in the copy, because the point is to make real changes on disk —
 * an edit, a rename that breaks a caller, a new file, and a deletion.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { analyzeRepo } from '../src/extract/analyze.js';
import { analyzeIncremental, buildCache } from '../src/extract/incremental.js';
import type { GraphFacts } from '../src/extract/types.js';

const source = path.resolve(process.argv[2] ?? './demo');

/** Copy a tree, skipping the things that would make the copy enormous or stale. */
function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.ichor') continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

/** Everything the graph is built from, as comparable strings. */
function fingerprint(facts: GraphFacts) {
  return {
    functions: facts.functions.map((f) => `${f.key}@${f.line}-${f.endLine}`).sort(),
    types: facts.types.map((t) => t.key).sort(),
    files: facts.files.map((f) => f.key).sort(),
    routes: facts.routes.map((r) => `${r.method} ${r.path} -> ${r.handlerKey}`).sort(),
    calls: facts.calls.map((c) => `${c.fromKey} -> ${c.toKey}${c.viaRender ? ' [r]' : ''}${c.viaContains ? ' [c]' : ''}`).sort(),
    references: facts.references.map((r) => `${r.fromKey} -> ${r.toKey}`).sort(),
    touches: facts.touches.map((t) => `${t.fromKey} -> ${t.modelKey}`).sort(),
    imports: facts.imports.map((i) => `${i.fromFileKey} -> ${i.toFileKey}`).sort(),
  };
}

let passed = 0;
let total = 0;

function compare(label: string, full: GraphFacts, incremental: GraphFacts, note: string): void {
  total++;
  const a = fingerprint(full);
  const b = fingerprint(incremental);
  const differences: string[] = [];

  for (const key of Object.keys(a) as (keyof typeof a)[]) {
    const left = a[key];
    const right = b[key];
    const missing = left.filter((x) => !right.includes(x));
    const extra = right.filter((x) => !left.includes(x));
    if (missing.length || extra.length) {
      differences.push(`${key}: ${missing.length} missing, ${extra.length} extra`);
      for (const m of missing.slice(0, 2)) differences.push(`    only in full:        ${m}`);
      for (const e of extra.slice(0, 2)) differences.push(`    only in incremental: ${e}`);
    }
  }

  if (differences.length === 0) {
    passed++;
    console.log(`  ✓ ${label}  — ${note}`);
  } else {
    console.log(`  ✗ ${label}  — ${note}`);
    for (const d of differences) console.log(`      ${d}`);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ichor-incr-'));
const repo = path.join(work, 'repo');
copyTree(source, repo);
console.log(`\n  copied ${path.basename(source)} to a scratch tree\n`);

// Baseline: a full read, and the cache that goes with it.
const base = analyzeRepo(repo);
const baseCache = buildCache(repo, base);
console.log(`  baseline: ${base.files.length} files, ${base.functions.length} functions, ${base.calls.length} calls\n`);

// ---- nothing changed -------------------------------------------------------
{
  const result = analyzeIncremental(repo, base, baseCache);
  total++;
  if (result.filesReparsed === 0 && result.mode === 'incremental') {
    passed++;
    console.log('  ✓ an unchanged tree re-reads nothing');
  } else {
    console.log(`  ✗ an unchanged tree re-read ${result.filesReparsed} files (${result.mode})`);
  }
}

// ---- an ordinary edit ------------------------------------------------------
const sourceFiles = base.files.filter((f) => !f.path.includes('.test.')).map((f) => f.path);
const target = sourceFiles.find((f) => f.endsWith('.ts')) ?? sourceFiles[0];
{
  const full = path.join(repo, target);
  fs.writeFileSync(full, `${fs.readFileSync(full, 'utf8')}\nexport function addedByTest(): number { return 1; }\n`);

  const incremental = analyzeIncremental(repo, base, baseCache);
  const fresh = analyzeRepo(repo);
  compare('an added function', fresh, incremental.facts, `${incremental.filesReparsed} of ${incremental.filesTotal} files re-read`);
}

// ---- a rename that breaks callers -----------------------------------------
// The case that catches a lazy implementation: a caller in a file that did NOT
// change now points at a function that no longer exists.
{
  const before = analyzeRepo(repo);
  const beforeCache = buildCache(repo, before);

  const named = before.functions.find(
    (f) => f.exported && !f.name.includes('.') && before.calls.some((c) => c.toKey === f.key),
  );
  if (!named) {
    console.log('  – no exported function with a caller; skipping the rename case');
  } else {
    const full = path.join(repo, named.file);
    const text = fs.readFileSync(full, 'utf8');
    fs.writeFileSync(full, text.replace(new RegExp(`\\b${named.name}\\b`, 'g'), `${named.name}Renamed`));

    const incremental = analyzeIncremental(repo, before, beforeCache);
    const fresh = analyzeRepo(repo);
    compare(
      `renaming ${named.name}, which others call`,
      fresh,
      incremental.facts,
      `${incremental.filesReparsed} of ${incremental.filesTotal} files re-read`,
    );
  }
}

// ---- a new file ------------------------------------------------------------
{
  const before = analyzeRepo(repo);
  const beforeCache = buildCache(repo, before);
  const dir = path.dirname(path.join(repo, target));
  fs.writeFileSync(
    path.join(dir, 'brand-new.ts'),
    'export function brandNew(): string { return "new"; }\n',
  );

  const incremental = analyzeIncremental(repo, before, beforeCache);
  const fresh = analyzeRepo(repo);
  compare('a new file', fresh, incremental.facts, `${incremental.filesReparsed} of ${incremental.filesTotal} files re-read`);
}

// ---- a deleted file --------------------------------------------------------
{
  const before = analyzeRepo(repo);
  const beforeCache = buildCache(repo, before);
  fs.unlinkSync(path.join(path.dirname(path.join(repo, target)), 'brand-new.ts'));

  const incremental = analyzeIncremental(repo, before, beforeCache);
  const fresh = analyzeRepo(repo);
  compare('a deleted file', fresh, incremental.facts, `mode: ${incremental.mode}`);
}

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${passed}/${total} incremental checks passed\n`);
if (passed !== total) process.exitCode = 1;
