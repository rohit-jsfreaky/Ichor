/**
 * Run the analyzer and print what it found.
 *
 *   npm run analyze -- ./demo
 *
 * Prints a resolution rate, not just successes, because an unstated unresolved
 * count is a lie by omission (docs/ENGINEERING-RULES.md rule 2).
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { analyzeRepo } from '../src/extract/analyze.js';

const target = process.argv[2] ?? './demo';
const root = path.resolve(target);

if (!fs.existsSync(root)) {
  console.error(`no such directory: ${root}`);
  process.exit(1);
}

console.log(`\nAnalyzing ${root}\n`);
const facts = analyzeRepo(root);
const s = facts.stats;

const pct = (n: number) => (s.callSitesTotal ? ((n / s.callSitesTotal) * 100).toFixed(1) : '0.0');

console.log('── totals ──────────────────────────────');
console.log(`  files          ${facts.files.length}`);
console.log(`  functions      ${facts.functions.length}`);
console.log(`  routes         ${facts.routes.length}`);
console.log(`  types          ${facts.types.length}`);
console.log(`  models         ${facts.models.length}`);
console.log(`  fields         ${facts.fields.length}`);
console.log(`  CALLS edges    ${facts.calls.length}`);
console.log(`  TOUCHES edges  ${facts.touches.length}`);
console.log(`  IMPORTS edges  ${facts.imports.length}`);

console.log('\n── call resolution ─────────────────────');
console.log(`  call sites     ${s.callSitesTotal}`);
console.log(`  in-repo        ${s.callSitesResolvedInRepo}  (${pct(s.callSitesResolvedInRepo)}%)`);
console.log(`  external       ${s.callSitesExternal}  (${pct(s.callSitesExternal)}%)`);
console.log(`  UNRESOLVED     ${s.callSitesUnresolved}  (${pct(s.callSitesUnresolved)}%)`);
console.log(
  `  type refs      ${s.typeRefsResolved} resolved in-repo` +
    // Most of the remainder are React, Prisma and other library types. Those are
    // not failures — they are simply not ours — but we do not have a cheap way to
    // separate them from a genuine miss, so the label says both.
    (s.typeRefsUnresolved > 0 ? `, ${s.typeRefsUnresolved} external or unresolved` : ''),
);
if (s.edgesDropped > 0) {
  // Should never happen. If it does, an edge was found that could not be
  // anchored to both ends, and saying so beats a graph that is quietly missing
  // relationships (rule 2).
  console.log(`  ⚠ edges dropped ${s.edgesDropped}  (endpoint node was not emitted)`);
}
console.log(`  took           ${s.durationMs}ms`);

console.log('\n── routes ──────────────────────────────');
for (const r of facts.routes) console.log(`  ${r.method.padEnd(6)} ${r.path.padEnd(24)} ${r.file}:${r.line}`);

console.log('\n── models ──────────────────────────────');
for (const m of facts.models) {
  const own = facts.fields.filter((f) => f.model === m.name);
  const unique = own.filter((f) => f.isUnique).map((f) => f.name);
  console.log(`  ${m.name.padEnd(10)} ${own.length} fields${unique.length ? `   unique: ${unique.join(', ')}` : ''}`);
}

console.log('\n── prisma touches ──────────────────────');
for (const t of facts.touches) {
  const fn = facts.functions.find((f) => f.key === t.fromKey);
  const model = facts.models.find((m) => m.key === t.modelKey);
  const mark = t.isWrite ? 'W' : 'r';
  console.log(`  [${mark}] ${(fn?.name ?? '?').padEnd(20)} → ${(model?.name ?? '?').padEnd(10)} ${t.operation.padEnd(14)} ${t.file}:${t.line}`);
}

console.log('\n── call edges ──────────────────────────');
const nameOf = (key: string) => facts.functions.find((f) => f.key === key)?.name ?? key;
for (const c of facts.calls) console.log(`  ${nameOf(c.fromKey).padEnd(22)} → ${nameOf(c.toKey).padEnd(22)} ${c.file}:${c.line}`);

console.log('');
