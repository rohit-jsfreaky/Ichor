/**
 * Understand a change that has not happened yet.
 *
 * A PreToolUse hook fires BEFORE the write, and carries the content the agent is
 * about to put on disk. That is what makes it possible to classify a brand-new
 * file by what it reaches, rather than by the useless fact that it is new.
 *
 * Parsed standalone and in memory — we cannot add it to the repo's ts-morph
 * Project without paying a full reload on every keystroke-sized edit. So
 * resolution here is by NAME and IMPORT PATH rather than by the type checker.
 * That is weaker than the analyzer, and the weakness is stated rather than
 * hidden: a pending-file edge is a *candidate*, and classification treats it as
 * corroborating evidence, never as proof of a call.
 */

import { Project, SyntaxKind, Node, ScriptTarget } from 'ts-morph';
import * as path from 'node:path';
import { PRISMA_OPS, PRISMA_WRITE_OPS, HTTP_METHODS } from '../extract/types.js';

export interface PendingFacts {
  /** Repo-relative path of the file being written. */
  file: string;
  /** Repo-relative paths this file imports (relative imports only). */
  importsRepoFiles: string[];
  /** Bare module specifiers, e.g. `react`, `@prisma/client`. */
  importsPackages: string[];
  /** Identifiers this file calls, by name. */
  callsNames: string[];
  /** Prisma models touched, with the operation. */
  touches: { model: string; operation: string; isWrite: boolean }[];
  /** HTTP methods exported, if this is a Next.js route file. */
  routeMethods: string[];
  /** Derived URL path when the file location looks like an App Router route. */
  routePath?: string;
  /**
   * Names this file exports, read from syntax.
   *
   * The file's public surface — what other code is allowed to depend on. Compared
   * against what the graph already records so that REMOVING an export can be
   * distinguished from changing a function's insides: the first breaks callers,
   * the second is ordinary work.
   */
  exportedNames: string[];
  /** True for *.test.ts / *.spec.ts. */
  isTest: boolean;
  /** Set when the content could not be parsed — classification must not guess. */
  parseError?: string;
  /**
   * Syntax errors in the content, counted.
   *
   * A half-applied edit is routinely invalid: an agent inserting `try {` now and
   * `} catch {}` on the next call produces an unbalanced file in between, and
   * ts-morph recovers from that silently rather than failing. The recovered tree
   * simply stops early — so every export below the break looks DELETED.
   *
   * That challenged an ordinary edit to `createVendor` for "no longer exporting"
   * two functions that were never touched. Anything reasoning about what a file
   * does or does not contain has to know the parse was clean first.
   */
  syntaxErrors: number;
}

/** Shared, so repeated hook calls do not each build a compiler instance. */
const scratch = new Project({
  useInMemoryFileSystem: true,
  compilerOptions: { target: ScriptTarget.ES2022, allowJs: true, jsx: 4 /* ReactJSX */ },
});

let counter = 0;

export function parsePending(repoRelativePath: string, content: string): PendingFacts {
  const facts: PendingFacts = {
    file: repoRelativePath.replace(/\\/g, '/'),
    importsRepoFiles: [],
    importsPackages: [],
    callsNames: [],
    touches: [],
    routeMethods: [],
    exportedNames: [],
    syntaxErrors: 0,
    isTest: /\.(test|spec)\.tsx?$/.test(repoRelativePath),
  };

  const extension = repoRelativePath.endsWith('.tsx') ? '.tsx' : '.ts';
  // Unique name per call: reusing one path would leave stale AST between edits.
  const virtualPath = `/pending-${counter++}${extension}`;

  let source;
  try {
    source = scratch.createSourceFile(virtualPath, content, { overwrite: true });
  } catch (error) {
    facts.parseError = (error as Error).message;
    return facts;
  }

  try {
    /**
     * The PARSER's own errors, not the type checker's.
     *
     * `parseDiagnostics` is internal to the TypeScript API, and it is the only way
     * to ask this question cheaply: `getPreEmitDiagnostics()` answers it too but
     * builds the whole Program and resolves every import into node_modules — the
     * exact cost that made `analyzeRepo` run out of memory on three real repos.
     */
    const parsed = source.compilerNode as unknown as { parseDiagnostics?: unknown[] };
    facts.syntaxErrors = parsed.parseDiagnostics?.length ?? 0;

    // ---- imports --------------------------------------------------------
    for (const declaration of source.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (specifier.startsWith('.')) {
        facts.importsRepoFiles.push(resolveRelativeImport(facts.file, specifier));
      } else {
        facts.importsPackages.push(specifier);
      }
    }

    // ---- route handlers -------------------------------------------------
    if (/(^|\/)app\/.*\/route\.tsx?$/.test(facts.file)) {
      facts.routePath = routePathFor(facts.file);
      for (const fn of source.getFunctions()) {
        const name = fn.getName();
        if (name && HTTP_METHODS.has(name) && fn.isExported()) facts.routeMethods.push(name);
      }
      for (const variable of source.getVariableDeclarations()) {
        const name = variable.getName();
        if (HTTP_METHODS.has(name) && variable.isExported()) facts.routeMethods.push(name);
      }
    }

    // ---- calls and prisma touches ---------------------------------------
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();

      const prismaHit = asPrismaCall(expression);
      if (prismaHit) {
        facts.touches.push({
          model: prismaHit.model,
          operation: prismaHit.operation,
          isWrite: PRISMA_WRITE_OPS.has(prismaHit.operation),
        });
        continue;
      }

      if (Node.isIdentifier(expression)) {
        facts.callsNames.push(expression.getText());
      } else if (Node.isPropertyAccessExpression(expression)) {
        facts.callsNames.push(expression.getName());
      }
    }

    // JSX component usage counts as a call — <VendorForm /> is a use, not decoration.
    for (const kind of [SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxOpeningElement] as const) {
      for (const element of source.getDescendantsOfKind(kind)) {
        const tag = element.getTagNameNode();
        if (Node.isIdentifier(tag) && /^[A-Z]/.test(tag.getText())) facts.callsNames.push(tag.getText());
      }
    }

    // ---- exported surface -------------------------------------------------
    //
    // Syntax only. `getExportedDeclarations()` answers the same question through
    // the type checker, which builds the whole Program and resolves every import
    // into node_modules — measured at 13.7 seconds on 49 route files, and the
    // reason `analyzeRepo` ran out of memory on three real repositories.
    const keyword = (node: { hasExportKeyword?: () => boolean }) => node.hasExportKeyword?.() === true;

    for (const fn of source.getFunctions()) {
      const name = fn.getName();
      if (name && keyword(fn)) facts.exportedNames.push(name);
    }
    for (const declaration of [
      ...source.getClasses(),
      ...source.getInterfaces(),
      ...source.getTypeAliases(),
      ...source.getEnums(),
    ]) {
      const name = declaration.getName();
      if (name && keyword(declaration)) facts.exportedNames.push(name);
    }
    for (const variable of source.getVariableDeclarations()) {
      if (keyword(variable)) facts.exportedNames.push(variable.getName());
    }
    // `export { a, b as c }` — the LOCAL name, since that is what the graph holds.
    for (const declaration of source.getExportDeclarations()) {
      if (declaration.getModuleSpecifier()) continue; // a re-export, declared elsewhere
      for (const spec of declaration.getNamedExports()) facts.exportedNames.push(spec.getName());
    }

    facts.exportedNames = [...new Set(facts.exportedNames)];
    facts.callsNames = [...new Set(facts.callsNames)];
    facts.importsRepoFiles = [...new Set(facts.importsRepoFiles)];
  } catch (error) {
    facts.parseError = (error as Error).message;
  } finally {
    scratch.removeSourceFile(source);
  }

  return facts;
}

interface PrismaCall {
  model: string;
  operation: string;
}

function asPrismaCall(expression: Node): PrismaCall | undefined {
  const operationAccess = expression.asKind(SyntaxKind.PropertyAccessExpression);
  if (!operationAccess) return undefined;

  const operation = operationAccess.getName();
  if (!PRISMA_OPS.has(operation)) return undefined;

  const modelAccess = operationAccess.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
  if (!modelAccess) return undefined;

  const base = modelAccess.getExpression().getText();
  if (!/(^|\.)(prisma|db)$/i.test(base)) return undefined;

  return { model: modelAccess.getName(), operation };
}

/** `src/app/api/x/route.ts` + `../../lib/y` -> `src/lib/y` */
function resolveRelativeImport(fromFile: string, specifier: string): string {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  return resolved.replace(/\.(ts|tsx|js|jsx)$/, '');
}

function routePathFor(filePath: string): string {
  const afterApp = filePath.replace(/^.*?(?:^|\/)app\//, '');
  const withoutFile = afterApp.replace(/\/route\.tsx?$/, '');
  const cleaned = withoutFile.replace(/\/\([^)]+\)/g, '');
  return `/${cleaned}`.replace(/\/+/g, '/');
}
