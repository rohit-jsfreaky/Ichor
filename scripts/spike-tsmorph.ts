/**
 * Day-1 spike: can we walk a real Next.js route handler down to a Prisma call?
 *
 *   npm run spike -- ./targets/documenso
 *
 * This is the only genuine unknown in Ichor's design. Everything else is volume.
 * The question is narrow and answerable in minutes:
 *
 *   1. can ts-morph load a large real-world Next.js project at all?
 *   2. can we find route handlers (app/api/ ** /route.ts exporting GET/POST/...)?
 *   3. can we resolve a call expression to the function it actually calls,
 *      ACROSS FILES?  <- the make-or-break one
 *   4. can we recognise prisma.<model>.<op>() calls?
 *
 * Question 3 is the risk. If cross-file resolution is poor on a real codebase,
 * our chains are short, the demo is weak, and we would rather find out now than
 * on day 3. The script prints a resolution RATE, because a rate is the honest
 * measure — see docs/ENGINEERING-RULES.md rule 2.
 *
 * This is a throwaway probe, not production code. It does not touch HydraDB.
 */

import { Project, SyntaxKind, type SourceFile, type CallExpression } from 'ts-morph';
import * as path from 'node:path';
import * as fs from 'node:fs';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const repoRoot = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) fail('usage: npm run spike -- <path-to-repo>');
if (!fs.existsSync(repoRoot)) fail(`no such directory: ${repoRoot}`);

console.log(`\nIchor ts-morph spike\nrepo: ${repoRoot}\n`);

// ---------------------------------------------------------------- 1. load
const started = Date.now();

// A tsconfig gives ts-morph real module resolution, which is what makes
// cross-file call resolution work. Without it we fall back to globbing, and
// resolution quality drops — worth reporting either way.
const tsconfig = ['tsconfig.json', 'apps/web/tsconfig.json', 'packages/tsconfig.json']
  .map((p) => path.join(repoRoot, p))
  .find((p) => fs.existsSync(p));

console.log(tsconfig ? `using tsconfig: ${path.relative(repoRoot, tsconfig)}` : 'no tsconfig found — globbing instead');

const project = new Project(
  tsconfig
    ? { tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: false }
    : { skipFileDependencyResolution: false },
);

if (!tsconfig) {
  project.addSourceFilesAtPaths([
    `${repoRoot}/**/*.{ts,tsx}`,
    `!${repoRoot}/**/node_modules/**`,
    `!${repoRoot}/**/*.d.ts`,
  ]);
}

const sourceFiles = project.getSourceFiles().filter((f) => !f.getFilePath().includes('node_modules'));
console.log(`loaded ${sourceFiles.length} source files in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

if (sourceFiles.length === 0) fail('no source files loaded — wrong path, or the repo needs `npm install` first');

// ------------------------------------------------- 2. find route handlers
interface RouteHandler {
  method: string;
  routePath: string;
  file: SourceFile;
  fnName: string;
}

const routes: RouteHandler[] = [];

for (const file of sourceFiles) {
  const filePath = file.getFilePath();
  // Next.js App Router convention: app/api/<segments>/route.ts
  if (!/[\\/]app[\\/].*[\\/]route\.tsx?$/.test(filePath)) continue;

  for (const [name, decls] of file.getExportedDeclarations()) {
    if (!HTTP_METHODS.has(name)) continue;
    const routePath =
      '/' +
      path
        .relative(repoRoot, filePath)
        .replace(/\\/g, '/')
        .replace(/^.*?app\//, '')
        .replace(/\/route\.tsx?$/, '');
    routes.push({ method: name, routePath, file, fnName: name });
    void decls;
  }
}

console.log(`── routes ──────────────────────────────────`);
console.log(`found ${routes.length} route handlers`);
for (const r of routes.slice(0, 8)) console.log(`  ${r.method.padEnd(6)} ${r.routePath}`);
if (routes.length > 8) console.log(`  … and ${routes.length - 8} more`);

// -------------------------------------- 3. call resolution rate (the risk)
let callsTotal = 0;
let callsResolvedInRepo = 0;
let callsResolvedExternal = 0;
let callsUnresolved = 0;

// Sample rather than sweep: this is a probe, and a whole monorepo is slow.
const sample = sourceFiles.slice(0, 400);

for (const file of sample) {
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    callsTotal++;
    try {
      const expr = call.getExpression();
      const symbol = expr.getSymbol() ?? expr.getType().getSymbol();
      const decls = symbol?.getDeclarations() ?? [];
      if (decls.length === 0) {
        callsUnresolved++;
        continue;
      }
      const declFile = decls[0].getSourceFile().getFilePath();
      if (declFile.includes('node_modules') || declFile.endsWith('.d.ts')) callsResolvedExternal++;
      else callsResolvedInRepo++;
    } catch {
      callsUnresolved++;
    }
  }
}

const resolvedPct = callsTotal ? (((callsResolvedInRepo + callsResolvedExternal) / callsTotal) * 100).toFixed(1) : '0';
const inRepoPct = callsTotal ? ((callsResolvedInRepo / callsTotal) * 100).toFixed(1) : '0';

console.log(`\n── call resolution (${sample.length} files sampled) ──`);
console.log(`  call sites          ${callsTotal}`);
console.log(`  resolved in-repo    ${callsResolvedInRepo}  (${inRepoPct}%)   <- these become CALLS edges`);
console.log(`  resolved external   ${callsResolvedExternal}`);
console.log(`  unresolved          ${callsUnresolved}`);
console.log(`  resolution rate     ${resolvedPct}%`);

// ------------------------------------------------ 4. find Prisma sinks
interface PrismaHit { model: string; op: string; file: string; line: number; }
const prismaHits: PrismaHit[] = [];

function asPrismaCall(call: CallExpression): PrismaHit | undefined {
  // Shape we want: <something>.prisma.<model>.<op>(...) or prisma.<model>.<op>(...)
  const prop = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
  if (!prop) return undefined;
  const op = prop.getName();
  const modelAccess = prop.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
  if (!modelAccess) return undefined;
  const model = modelAccess.getName();
  const base = modelAccess.getExpression().getText();
  if (!/prisma|db/i.test(base)) return undefined;
  const src = call.getSourceFile();
  return { model, op, file: path.relative(repoRoot, src.getFilePath()), line: call.getStartLineNumber() };
}

for (const file of sample) {
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const hit = asPrismaCall(call);
    if (hit) prismaHits.push(hit);
  }
}

const byModel = new Map<string, number>();
for (const h of prismaHits) byModel.set(h.model, (byModel.get(h.model) ?? 0) + 1);

console.log(`\n── prisma sinks ────────────────────────────`);
console.log(`found ${prismaHits.length} prisma calls across ${byModel.size} models`);
for (const [model, n] of [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(n).padStart(4)}  ${model}`);
}

// ---------------------------------------------------------------- verdict
console.log(`\n── verdict ─────────────────────────────────`);
const good = routes.length > 0 && prismaHits.length > 0 && Number(inRepoPct) > 15;
if (good) {
  console.log('  GO. Routes found, Prisma calls found, cross-file resolution is usable.');
  console.log('  Ichor\'s design holds. Proceed to full extraction on day 2.');
} else {
  console.log('  PROBLEM — check which of these is zero or low:');
  if (!routes.length) console.log('   · no routes: this repo may not use the Next.js App Router');
  if (!prismaHits.length) console.log('   · no prisma calls: it may not use Prisma, or wraps it behind a repository layer');
  if (Number(inRepoPct) <= 15) console.log('   · low in-repo resolution: run `npm install` in the target so types resolve');
}
console.log('');
