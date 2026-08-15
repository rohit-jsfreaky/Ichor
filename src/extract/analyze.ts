/**
 * Read a TypeScript repository into graph facts.
 *
 * Uses ts-morph (the real TypeScript compiler) so call targets are *resolved*,
 * not guessed. If a call cannot be resolved we drop the edge and count it —
 * never approximate (docs/ENGINEERING-RULES.md rules 1 and 2).
 *
 * Pure: takes a path, returns facts. No HydraDB, no side effects, so it can be
 * tested against demo/ with nothing running.
 */

import { Project, SyntaxKind, Node } from 'ts-morph';
import type { CallExpression, SourceFile, FunctionDeclaration, VariableDeclaration } from 'ts-morph';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { nodeKey, normalisePath } from '../ids.js';
import { parsePrismaSchema } from './prismaSchema.js';
import {
  HTTP_METHODS, PRISMA_OPS, PRISMA_WRITE_OPS,
  type GraphFacts, type FunctionFact, type FileFact, type RouteFact,
  type CallEdge, type TouchEdge, type ImportEdge, type TypeFact, type ReferenceEdge,
} from './types.js';

const TSCONFIG_CANDIDATES = ['tsconfig.json', 'apps/web/tsconfig.json', 'packages/tsconfig.json'];

export interface AnalyzeOptions {
  /** Skip the node_modules type graph. Faster, slightly worse resolution. */
  skipLibs?: boolean;
}

export function analyzeRepo(repoRoot: string, options: AnalyzeOptions = {}): GraphFacts {
  const started = Date.now();
  const root = path.resolve(repoRoot);

  const project = loadProject(root, options);
  const sourceFiles = project
    .getSourceFiles()
    .filter((f) => !f.getFilePath().includes('node_modules') && !f.getFilePath().endsWith('.d.ts'));

  const rel = (f: SourceFile) => normalisePath(f.getFilePath(), root);

  // ---- files -------------------------------------------------------------
  const files: FileFact[] = sourceFiles.map((f) => ({
    key: nodeKey('file', rel(f)),
    path: rel(f),
  }));

  // ---- functions ---------------------------------------------------------
  // Built first and indexed by declaration node, so call resolution can map a
  // resolved declaration straight back to the function key.
  const functions: FunctionFact[] = [];
  const keyByDeclaration = new Map<Node, string>();

  for (const file of sourceFiles) {
    const filePath = rel(file);
    const isTest = /\.(test|spec)\.tsx?$/.test(filePath);

    for (const decl of declaredFunctions(file)) {
      const name = decl.name;
      const key = nodeKey('function', filePath, name);

      functions.push({
        key,
        name,
        file: filePath,
        line: decl.node.getStartLineNumber(),
        exported: decl.exported,
        isComponent: isReactComponent(name, filePath),
        isTest,
      });
      keyByDeclaration.set(decl.node, key);
    }
  }

  // ---- types -------------------------------------------------------------
  // Interfaces, type aliases, enums and classes. Indexed by declaration node in
  // the SAME map as functions, so a resolved reference maps straight to a key
  // whichever kind it turns out to be.
  const types: TypeFact[] = [];

  for (const file of sourceFiles) {
    const filePath = rel(file);
    for (const declared of declaredTypes(file)) {
      const key = nodeKey('type', filePath, declared.name);
      types.push({
        key,
        name: declared.name,
        kind: declared.kind,
        file: filePath,
        line: declared.node.getStartLineNumber(),
        exported: declared.exported,
      });
      keyByDeclaration.set(declared.node, key);
    }
  }

  // ---- imports -----------------------------------------------------------
  const imports: ImportEdge[] = [];
  for (const file of sourceFiles) {
    const fromKey = nodeKey('file', rel(file));
    for (const decl of file.getImportDeclarations()) {
      const target = decl.getModuleSpecifierSourceFile();
      if (!target || target.getFilePath().includes('node_modules')) continue;
      imports.push({ fromFileKey: fromKey, toFileKey: nodeKey('file', rel(target)) });
    }
  }

  // ---- prisma models -----------------------------------------------------
  const { models, fields } = parsePrismaSchema(root);
  const modelKeyByName = new Map(models.map((m) => [m.name.toLowerCase(), m.key]));

  // ---- calls, prisma touches, routes -------------------------------------
  const calls: CallEdge[] = [];
  const touches: TouchEdge[] = [];
  const routes: RouteFact[] = [];

  let callSitesTotal = 0;
  let callSitesResolvedInRepo = 0;
  let callSitesExternal = 0;
  let callSitesUnresolved = 0;

  for (const file of sourceFiles) {
    const filePath = rel(file);

    // Routes: Next.js App Router puts handlers in app/**/route.ts, exported
    // under the HTTP method name.
    if (/(^|\/)app\/.*\/route\.tsx?$/.test(filePath)) {
      for (const [name, decls] of file.getExportedDeclarations()) {
        if (!HTTP_METHODS.has(name)) continue;

        // Follow the export to the declaration it actually names.
        //
        // A real Next.js pattern is one handler serving every verb:
        //
        //   const handler = async (req) => { … }
        //   export { handler as DELETE, handler as GET, handler as POST };
        //
        // Keying the route off the EXPORTED name invents `#GET`, which no
        // function node ever carries, and the resulting edge points at nothing.
        // `getExportedDeclarations` hands back the underlying declaration, so we
        // key off that and the route points at the real handler.
        const declaration = decls[0];
        const handlerKey =
          (declaration && keyByDeclaration.get(declaration)) ??
          nodeKey('function', filePath, name);
        routes.push({
          key: nodeKey('route', `${name} ${routePathFor(filePath)}`),
          method: name,
          path: routePathFor(filePath),
          handlerKey,
          file: filePath,
          line: decls[0]?.getStartLineNumber() ?? 1,
        });
      }
    }

    // React components are used as <Component />, which is a JSX element and
    // not a CallExpression — so without this, every page->component edge is
    // missing and UI entry points look disconnected from the code they drive.
    for (const kind of [SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxOpeningElement] as const) {
      for (const element of file.getDescendantsOfKind(kind)) {
        const tag = element.getTagNameNode();
        // Lowercase tags are intrinsic elements (<div>), not our components.
        if (!Node.isIdentifier(tag) || !/^[A-Z]/.test(tag.getText())) continue;

        const targetKey = firstRepoKey(tag.getDefinitionNodes(), keyByDeclaration);
        const enclosingKey = enclosingFunctionKey(element, keyByDeclaration);
        if (targetKey && enclosingKey && enclosingKey !== targetKey) {
          calls.push({ fromKey: enclosingKey, toKey: targetKey, file: filePath, line: element.getStartLineNumber() });
        }
      }
    }

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      callSitesTotal++;

      const enclosingKey = enclosingFunctionKey(call, keyByDeclaration);
      const line = call.getStartLineNumber();

      // Prisma access is a property chain, not a resolvable function in our
      // repo, so it is checked before ordinary call resolution.
      const prismaHit = asPrismaCall(call);
      if (prismaHit) {
        const modelKey = modelKeyByName.get(prismaHit.model.toLowerCase());
        if (modelKey && enclosingKey) {
          touches.push({
            fromKey: enclosingKey,
            modelKey,
            operation: prismaHit.operation,
            isWrite: PRISMA_WRITE_OPS.has(prismaHit.operation),
            file: filePath,
            line,
          });
        }
        callSitesExternal++;
        continue;
      }

      const targetKey = resolveCallTarget(call, keyByDeclaration);
      if (targetKey === 'external') {
        callSitesExternal++;
        continue;
      }
      if (!targetKey) {
        callSitesUnresolved++;
        continue;
      }

      callSitesResolvedInRepo++;
      if (enclosingKey && enclosingKey !== targetKey) {
        calls.push({ fromKey: enclosingKey, toKey: targetKey, file: filePath, line });
      }
    }
  }

  // ---- type references ----------------------------------------------------
  //
  // Which function mentions which type — in a parameter, a return, an
  // annotation, a cast. Resolved through the compiler exactly like a call, so
  // `Vendor` here is THE `Vendor` declared over there and not merely a word that
  // matches. Unresolved mentions are counted, never guessed (rules 1 and 2).
  const references: ReferenceEdge[] = [];
  let typeRefsResolved = 0;
  let typeRefsUnresolved = 0;

  for (const file of sourceFiles) {
    const filePath = rel(file);

    for (const reference of file.getDescendantsOfKind(SyntaxKind.TypeReference)) {
      const nameNode = reference.getTypeName();
      if (!Node.isIdentifier(nameNode)) continue;

      const enclosingKey = enclosingFunctionKey(reference, keyByDeclaration);
      if (!enclosingKey) continue; // a type used outside any function is not an edge we can anchor

      const targetKey = firstRepoKey(nameNode.getDefinitionNodes(), keyByDeclaration);
      if (!targetKey) {
        typeRefsUnresolved++;
        continue;
      }
      if (targetKey === enclosingKey) continue;

      typeRefsResolved++;
      references.push({
        fromKey: enclosingKey,
        toKey: targetKey,
        file: filePath,
        line: reference.getStartLineNumber(),
      });
    }
  }

  // ---- consistency --------------------------------------------------------
  //
  // Every edge must land on a node we actually emit. HydraDB does not skip an
  // edge whose endpoint is missing — it rejects the whole statement with
  // "MATCH endpoint vertex … does not exist", so ONE unusual file aborts the
  // analysis of an entire repository. That is exactly what happened on a
  // 1,386-file codebase, and a graph that only builds for tidy repos is not a
  // graph anyone can rely on.
  //
  // Dropped edges are counted and reported rather than silently discarded
  // (ENGINEERING-RULES rule 2).
  const functionKeys = new Set(functions.map((f) => f.key));
  const typeKeys = new Set(types.map((t) => t.key));
  const modelKeys = new Set(models.map((m) => m.key));
  const fileKeys = new Set(files.map((f) => f.key));

  const callsBefore = calls.length;
  const touchesBefore = touches.length;
  const routesBefore = routes.length;
  const importsBefore = imports.length;

  const keptCalls = calls.filter((c) => functionKeys.has(c.fromKey) && functionKeys.has(c.toKey));
  const keptTouches = touches.filter((t) => functionKeys.has(t.fromKey) && modelKeys.has(t.modelKey));
  const keptRoutes = routes.filter((r) => functionKeys.has(r.handlerKey));
  const keptImports = imports.filter(
    (i) => fileKeys.has(i.fromFileKey) && fileKeys.has(i.toFileKey),
  );
  // A reference can start at a function OR a type (one interface extending
  // another), and must land on a type we emitted.
  const referencesBefore = references.length;
  const keptReferences = references.filter(
    (r) => (functionKeys.has(r.fromKey) || typeKeys.has(r.fromKey)) && typeKeys.has(r.toKey),
  );

  const edgesDropped =
    callsBefore - keptCalls.length +
    (touchesBefore - keptTouches.length) +
    (routesBefore - keptRoutes.length) +
    (importsBefore - keptImports.length) +
    (referencesBefore - keptReferences.length);

  return {
    repoRoot: root,
    files,
    functions,
    types,
    routes: keptRoutes,
    models,
    fields,
    calls: keptCalls,
    references: keptReferences,
    touches: keptTouches,
    imports: keptImports,
    stats: {
      filesScanned: sourceFiles.length,
      callSitesTotal,
      callSitesResolvedInRepo,
      callSitesExternal,
      callSitesUnresolved,
      typeRefsResolved,
      typeRefsUnresolved,
      edgesDropped,
      durationMs: Date.now() - started,
    },
  };
}

// ---------------------------------------------------------------- internals

function loadProject(root: string, options: AnalyzeOptions): Project {
  const tsconfig = TSCONFIG_CANDIDATES
    .map((p) => path.join(root, p))
    .find((p) => fs.existsSync(p));

  if (tsconfig) {
    return new Project({
      tsConfigFilePath: tsconfig,
      skipAddingFilesFromTsConfig: false,
      skipFileDependencyResolution: options.skipLibs ?? false,
    });
  }

  // No tsconfig: glob the sources. Resolution is weaker, which the stats will show.
  const project = new Project({ skipFileDependencyResolution: options.skipLibs ?? false });
  project.addSourceFilesAtPaths([
    `${root}/**/*.{ts,tsx}`,
    `!${root}/**/node_modules/**`,
    `!${root}/**/*.d.ts`,
  ]);
  return project;
}

interface DeclaredFunction {
  name: string;
  node: Node;
  exported: boolean;
}

/**
 * Every named function in a file.
 *
 * Covers the three shapes that carry a name worth putting in a graph:
 * declarations, arrow/function expressions assigned to a variable, and class
 * methods. Anonymous callbacks are skipped — they have no stable identity to
 * challenge an edit against.
 */
function declaredFunctions(file: SourceFile): DeclaredFunction[] {
  const found: DeclaredFunction[] = [];

  for (const fn of file.getFunctions()) {
    const name = fn.getName();
    if (name) found.push({ name, node: fn, exported: isExported(fn) });
  }

  for (const variable of file.getVariableDeclarations()) {
    const initializer = variable.getInitializer();
    if (!initializer) continue;
    if (
      Node.isArrowFunction(initializer) ||
      Node.isFunctionExpression(initializer)
    ) {
      found.push({ name: variable.getName(), node: variable, exported: isExported(variable) });
    }
  }

  for (const cls of file.getClasses()) {
    const className = cls.getName() ?? 'anonymous';
    for (const method of cls.getMethods()) {
      found.push({ name: `${className}.${method.getName()}`, node: method, exported: isExported(cls) });
    }
  }

  return found;
}

interface DeclaredType {
  name: string;
  kind: 'interface' | 'alias' | 'enum' | 'class';
  node: Node;
  exported: boolean;
}

/**
 * Named types declared at the top level of a file.
 *
 * Classes appear here as well as contributing their methods to
 * `declaredFunctions` — a class is both a thing you call into and a shape you
 * refer to, and a task can be about either.
 */
function declaredTypes(file: SourceFile): DeclaredType[] {
  const found: DeclaredType[] = [];

  for (const node of file.getInterfaces()) {
    found.push({ name: node.getName(), kind: 'interface', node, exported: isExported(node) });
  }
  for (const node of file.getTypeAliases()) {
    found.push({ name: node.getName(), kind: 'alias', node, exported: isExported(node) });
  }
  for (const node of file.getEnums()) {
    found.push({ name: node.getName(), kind: 'enum', node, exported: isExported(node) });
  }
  for (const node of file.getClasses()) {
    const name = node.getName();
    if (name) found.push({ name, kind: 'class', node, exported: isExported(node) });
  }

  return found;
}

function isExported(node: FunctionDeclaration | VariableDeclaration | Node): boolean {
  const withExport = node as unknown as { isExported?: () => boolean };
  try {
    return withExport.isExported?.() ?? false;
  } catch {
    return false;
  }
}

/** Capitalised name in a .tsx file — good enough, and never load-bearing. */
function isReactComponent(name: string, filePath: string): boolean {
  return filePath.endsWith('.tsx') && /^[A-Z]/.test(name);
}

/** Walk up to the function a call sits inside, so the edge has a source. */
function enclosingFunctionKey(call: Node, keyByDeclaration: Map<Node, string>): string | undefined {
  let current: Node | undefined = call.getParent();
  while (current) {
    const key = keyByDeclaration.get(current);
    if (key) return key;

    // Arrow/function expressions are keyed by their VariableDeclaration.
    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      const parent = current.getParent();
      if (parent && keyByDeclaration.has(parent)) return keyByDeclaration.get(parent);
    }
    current = current.getParent();
  }
  return undefined;
}

/**
 * Resolve a call to the function it actually calls.
 *
 * Returns the function key, the string `'external'` for library calls, or
 * undefined when the compiler could not resolve it — which is counted, not
 * guessed at.
 */
function resolveCallTarget(call: CallExpression, keyByDeclaration: Map<Node, string>): string | 'external' | undefined {
  try {
    const declarations = declarationsFor(call.getExpression());
    if (declarations.length === 0) return undefined;

    for (const declaration of declarations) {
      const declFile = declaration.getSourceFile().getFilePath();
      if (declFile.includes('node_modules') || declFile.endsWith('.d.ts')) return 'external';

      const direct = keyByDeclaration.get(declaration);
      if (direct) return direct;

      // An arrow function resolves to its VariableDeclaration.
      const parent = declaration.getParent();
      if (parent && keyByDeclaration.has(parent)) return keyByDeclaration.get(parent);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** First declaration that maps to a function we know about, ignoring library code. */
function firstRepoKey(declarations: Node[], keyByDeclaration: Map<Node, string>): string | undefined {
  for (const declaration of declarations) {
    const declFile = declaration.getSourceFile().getFilePath();
    if (declFile.includes('node_modules') || declFile.endsWith('.d.ts')) continue;

    const direct = keyByDeclaration.get(declaration);
    if (direct) return direct;

    const parent = declaration.getParent();
    if (parent && keyByDeclaration.has(parent)) return keyByDeclaration.get(parent);
  }
  return undefined;
}

/**
 * Declarations a call expression could be referring to, following import aliases.
 *
 * The subtlety that costs a whole call graph: for `createVendor(body)` where
 * `createVendor` was imported, `getSymbol()` returns the *alias* symbol whose
 * only declaration is the `ImportSpecifier` in the importing file — not the
 * function in the file that defines it. Resolving that naively yields an
 * unresolvable node and every cross-file edge silently disappears.
 *
 * `getDefinitionNodes()` on the identifier follows through to the real
 * declaration, with `getAliasedSymbol()` as the fallback path.
 */
function declarationsFor(expression: Node): Node[] {
  // `foo()`
  if (Node.isIdentifier(expression)) {
    const defs = expression.getDefinitionNodes();
    if (defs.length > 0) return defs;
  }

  // `obj.method()` — resolve the property name, not the object.
  if (Node.isPropertyAccessExpression(expression)) {
    const defs = expression.getNameNode().getDefinitionNodes();
    if (defs.length > 0) return defs;
  }

  let symbol = expression.getSymbol() ?? expression.getType().getSymbol();
  const aliased = symbol?.getAliasedSymbol?.();
  if (aliased) symbol = aliased;

  return symbol?.getDeclarations() ?? [];
}

interface PrismaCall {
  model: string;
  operation: string;
}

/** Recognise `prisma.vendor.create(...)` and friends. */
function asPrismaCall(call: CallExpression): PrismaCall | undefined {
  const operationAccess = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
  if (!operationAccess) return undefined;

  const operation = operationAccess.getName();
  if (!PRISMA_OPS.has(operation)) return undefined;

  const modelAccess = operationAccess.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
  if (!modelAccess) return undefined;

  const base = modelAccess.getExpression().getText();
  if (!/(^|\.)(prisma|db)$/i.test(base)) return undefined;

  return { model: modelAccess.getName(), operation };
}

/** `src/app/api/vendors/route.ts` -> `/api/vendors` */
function routePathFor(filePath: string): string {
  const afterApp = filePath.replace(/^.*?(?:^|\/)app\//, '');
  const withoutFile = afterApp.replace(/\/route\.tsx?$/, '');
  // Next.js route groups like (marketing) do not appear in the URL.
  const cleaned = withoutFile.replace(/\/\([^)]+\)/g, '');
  return `/${cleaned}`.replace(/\/+/g, '/');
}
