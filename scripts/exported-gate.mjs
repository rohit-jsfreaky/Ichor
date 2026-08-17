/**
 * Does a syntactic "is this exported?" agree with the type checker's answer?
 *
 *   node scripts/exported-gate.mjs <repo>
 *
 * WHY
 *
 * `isExported()` in `src/extract/analyze.ts` calls ts-morph's `isExported()`,
 * which calls `getSymbol()`, which builds the whole TypeScript Program and
 * resolves every import into node_modules. On a twenty-file package of
 * better-auth that was 15,389 filesystem calls, 7 seconds and 350 MB — for a
 * question that the `export` keyword answers by itself.
 *
 * Replacing it is only safe if the replacement gives the SAME answer, so this
 * compares them declaration by declaration before anything is changed. A wrong
 * `exported` flag is not a crash — it quietly changes which functions look like a
 * codebase's public surface, and therefore which edits get challenged.
 *
 * Run on the demo AND on a real repository. The demo has no `export { … }`
 * statements at all, so it agrees with anything.
 */

import * as path from 'node:path';
import { Project, Node } from 'ts-morph';

const root = path.resolve(process.argv[2] ?? './demo');

const tsconfigCandidates = ['tsconfig.json', 'apps/web/tsconfig.json'];
const fs = (await import('node:fs')).default;
const tsconfig = tsconfigCandidates.map((p) => path.join(root, p)).find((p) => fs.existsSync(p));

const project = tsconfig
  ? new Project({
      tsConfigFilePath: tsconfig,
      skipAddingFilesFromTsConfig: false,
      skipFileDependencyResolution: true,
    })
  : new Project({ skipFileDependencyResolution: true });

if (!tsconfig) {
  project.addSourceFilesAtPaths([
    `${root}/**/*.{ts,tsx}`,
    `!${root}/**/node_modules/**`,
    `!${root}/**/*.d.ts`,
  ]);
}

const files = project
  .getSourceFiles()
  .filter((f) => !f.getFilePath().includes('node_modules') && !f.getFilePath().endsWith('.d.ts'));

/**
 * Names a file exports through a statement rather than a keyword.
 *
 *   export { foo, bar as baz }        <- foo and bar are exported
 *   export { thing } from './other'   <- NOT a local declaration, skipped
 *   export default foo                <- foo is exported
 *
 * The local name is what matters, not the exported alias: `export { foo as bar }`
 * makes the declaration named `foo` part of the public surface.
 */
function exportedByStatement(file) {
  const names = new Set();

  for (const decl of file.getExportDeclarations()) {
    // A re-export names something in ANOTHER file. Counting it here would mark an
    // unrelated local declaration of the same name as exported.
    if (decl.getModuleSpecifier()) continue;
    for (const spec of decl.getNamedExports()) names.add(spec.getName());
  }

  for (const assignment of file.getExportAssignments()) {
    const expression = assignment.getExpression();
    if (Node.isIdentifier(expression)) names.add(expression.getText());
  }

  return names;
}

/** The same question, answered from the syntax tree alone. */
function isExportedSyntactic(node, names) {
  const n = node;
  if (n.hasExportKeyword?.()) return true;
  if (n.hasDefaultKeyword?.()) return true;
  const name = n.getName?.();
  return name ? names.has(name) : false;
}

let checked = 0;
let disagreed = 0;
const examples = [];

for (const file of files) {
  const names = exportedByStatement(file);
  const declarations = [
    ...file.getFunctions(),
    ...file.getVariableDeclarations(),
    ...file.getClasses(),
    ...file.getInterfaces(),
    ...file.getTypeAliases(),
    ...file.getEnums(),
  ];

  for (const decl of declarations) {
    let byChecker;
    try {
      byChecker = decl.isExported?.() ?? false;
    } catch {
      continue;
    }
    const bySyntax = isExportedSyntactic(decl, names);
    checked++;
    if (byChecker !== bySyntax) {
      disagreed++;
      if (examples.length < 12) {
        examples.push(
          `${path.relative(root, file.getFilePath())}:${decl.getStartLineNumber()} ` +
            `${decl.getName?.() ?? '(anonymous)'} — checker ${byChecker}, syntax ${bySyntax}`,
        );
      }
    }
  }
}

console.log(`\n${root}`);
console.log(`  ${files.length} files, ${checked} declarations compared`);
console.log(`  ${disagreed === 0 ? '✓' : '✗'} ${disagreed} disagreements\n`);
for (const line of examples) console.log(`    ${line}`);
if (examples.length) console.log('');
process.exitCode = disagreed === 0 ? 0 : 1;
