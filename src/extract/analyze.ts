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

import { nodeKey, normalisePath, repoIdFor } from '../ids.js';
import { createResolver, parseAliases, type FileSymbols, type Resolver, type Resolution } from './symbols.js';
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
  /**
   * Analyse only these files (repo-relative), not the whole tree.
   *
   * Reading and parsing every file is where the time goes — 1,362 files cost
   * roughly 16 seconds, and almost all of it is work that has not changed since
   * the last run. When only a handful of files were edited, this parses only
   * those.
   *
   * `knownSymbols` MUST be supplied alongside, because resolution is a
   * cross-file question: `import { send } from './email'` can only be answered
   * with `./email`'s export table, and that file is not being parsed. The caller
   * merges the returned facts into the previous ones — see incremental.ts.
   */
  only?: string[];
  /**
   * Symbol tables for every file in the repo, from the previous full analysis.
   *
   * Tables for files being re-parsed are recomputed and override these.
   */
  knownSymbols?: Map<string, FileSymbols>;
}

export function analyzeRepo(repoRoot: string, options: AnalyzeOptions = {}): GraphFacts {
  const started = Date.now();
  const root = path.resolve(repoRoot);

  // Every key this analysis produces is scoped to this checkout, so two projects
  // can share one database without their `src/lib/db.ts` becoming one node.
  const repoId = repoIdFor(root);

  // With `only`, just those files are read from disk — the whole point of an
  // incremental run. Resolution still sees every file, through `knownSymbols`.
  const project = options.only
    ? projectFor(root, options.only)
    : loadProject(root, options);
  const sourceFiles = project
    .getSourceFiles()
    .filter((f) => !f.getFilePath().includes('node_modules') && !f.getFilePath().endsWith('.d.ts'));

  const rel = (f: SourceFile) => normalisePath(f.getFilePath(), root);

  // ---- files -------------------------------------------------------------
  const files: FileFact[] = sourceFiles.map((f) => ({
    key: nodeKey(repoId, 'file', rel(f)),
    path: rel(f),
  }));

  // ---- functions ---------------------------------------------------------
  // Built first and indexed by declaration node, so call resolution can map a
  // resolved declaration straight back to the function key.
  const functions: FunctionFact[] = [];
  const keyByDeclaration = new Map<Node, string>();
  const declarationStats: DeclarationStats = { duplicateNames: 0 };
  /** Parent -> nested function edges, merged into `calls` once both ends exist. */
  const containment: CallEdge[] = [];

  for (const file of sourceFiles) {
    const filePath = rel(file);
    const isTest = /\.(test|spec)\.tsx?$/.test(filePath);

    for (const decl of declaredFunctions(file, declarationStats)) {
      const name = decl.name;
      const key = nodeKey(repoId, 'function', filePath, name);

      functions.push({
        key,
        name,
        file: filePath,
        line: decl.node.getStartLineNumber(),
        endLine: decl.node.getEndLineNumber(),
        exported: decl.exported,
        isComponent: isReactComponent(name, filePath),
        isTest,
      });
      keyByDeclaration.set(decl.node, key);
      // A wrapped function lives across two nodes; both have to lead to the key,
      // or calls inside the body walk past it and lose their source.
      for (const body of decl.bodyNodes ?? []) keyByDeclaration.set(body, key);

      // Keep the parent joined to what it declares — see CallEdge.viaContains.
      if (decl.parent) {
        containment.push({
          fromKey: nodeKey(repoId, 'function', filePath, decl.parent),
          toKey: key,
          file: filePath,
          line: decl.node.getStartLineNumber(),
          viaContains: true,
        });
      }
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
      const key = nodeKey(repoId, 'type', filePath, declared.name);
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

  // ---- symbol tables -----------------------------------------------------
  //
  // What each file declares, imports and exports. Pure syntax, and the reason
  // this analysis no longer needs the type checker — see src/extract/symbols.ts.
  const declaredByFile = new Map<string, Map<string, string>>();
  const exportedByFile = new Map<string, Set<string>>();
  for (const fact of [...functions, ...types]) {
    let byName = declaredByFile.get(fact.file);
    if (!byName) { byName = new Map(); declaredByFile.set(fact.file, byName); }
    byName.set(fact.name, fact.key);

    if (fact.exported) {
      let exported = exportedByFile.get(fact.file);
      if (!exported) { exported = new Set(); exportedByFile.set(fact.file, exported); }
      exported.add(fact.name);
    }
  }

  const compilerOptions = project.getCompilerOptions();
  const aliases = parseAliases(
    compilerOptions.paths as Record<string, string[]> | undefined,
    compilerOptions.baseUrl ? normalisePath(compilerOptions.baseUrl, root) : '',
  );

  // Start from the previous run's tables so an incremental parse can resolve
  // names that live in files it is not reading. Freshly parsed files overwrite
  // their own entries below.
  const tables = new Map<string, FileSymbols>(options.knownSymbols ?? []);
  const knownFiles = new Set([...tables.keys(), ...files.map((f) => f.path)]);

  for (const file of sourceFiles) {
    const filePath = rel(file);
    const symbols: FileSymbols = {
      file: filePath,
      locals: declaredByFile.get(filePath) ?? new Map(),
      imports: new Map(),
      exports: new Map(),
      starExports: [],
    };

    for (const decl of file.getImportDeclarations()) {
      const module = decl.getModuleSpecifierValue();
      for (const named of decl.getNamedImports()) {
        symbols.imports.set(named.getAliasNode()?.getText() ?? named.getName(), {
          module,
          imported: named.getName(),
        });
      }
      const defaultImport = decl.getDefaultImport();
      if (defaultImport) symbols.imports.set(defaultImport.getText(), { module, imported: 'default' });
      const namespaceImport = decl.getNamespaceImport();
      if (namespaceImport) symbols.imports.set(namespaceImport.getText(), { module, imported: '*' });
    }

    // A declaration carrying `export` is itself an export; the `export { … }`
    // forms below are the only other way a name leaves a file.
    //
    // Unexported declarations are recorded too. `isExported()` is duck-typed and
    // returns false when it cannot tell, and refusing to resolve a name because
    // of that would silently drop real edges — far worse than resolving one that
    // a stricter reading would have kept private.
    for (const name of symbols.locals.keys()) symbols.exports.set(name, { local: name });
    void exportedByFile;

    // Default exports.
    //
    // Without these, `import AppLayout from './layout'` resolves to nothing —
    // the import binds the name `default`, and nothing ever registered it. On a
    // React codebase that is most components: one layout alone accounted for 74
    // lost edges, and the total was 726.
    for (const declaration of [...file.getFunctions(), ...file.getClasses()]) {
      const name = declaration.getName();
      if (name && declaration.isDefaultExport()) symbols.exports.set('default', { local: name });
    }
    // `export default Foo` as a statement of its own.
    for (const assignment of file.getExportAssignments()) {
      if (assignment.isExportEquals()) continue;
      const expression = assignment.getExpression();
      if (Node.isIdentifier(expression)) symbols.exports.set('default', { local: expression.getText() });
    }

    for (const decl of file.getExportDeclarations()) {
      const from = decl.getModuleSpecifierValue();
      if (decl.isNamespaceExport() && from) { symbols.starExports.push(from); continue; }
      for (const named of decl.getNamedExports()) {
        const exportedAs = named.getAliasNode()?.getText() ?? named.getName();
        symbols.exports.set(
          exportedAs,
          from ? { fromModule: from, imported: named.getName() } : { local: named.getName() },
        );
      }
    }

    tables.set(filePath, symbols);
  }

  const resolver = createResolver(tables, knownFiles, aliases);

  /** Where each declaration sits, so a route can report its handler's line. */
  const lineByKey = new Map<string, number>();
  for (const fact of [...functions, ...types]) lineByKey.set(fact.key, fact.line);

  // ---- instances ---------------------------------------------------------
  //
  // `const client = new McpClient(); client.request()` is a method call, but its
  // type needs no inference at all: `new McpClient()` says so outright. Without
  // this, every call through a class instance is lost — 18% of the edges in this
  // repository, which is class-heavy.
  //
  // A name bound to two different classes in one file is dropped rather than
  // picked between. Guessing which one a call meant would fabricate an edge, and
  // a missed edge is always cheaper than a wrong one (rule 1).
  const instancesByFile = new Map<string, Map<string, string | null>>();

  for (const file of sourceFiles) {
    const byName = new Map<string, string | null>();
    const bind = (name: string, typeName: string | undefined) => {
      if (!typeName) return;
      byName.set(name, byName.has(name) && byName.get(name) !== typeName ? null : typeName);
    };

    /**
     * `: Foo` — the declared type, read, not inferred.
     *
     * Unions are unwrapped because `let client: GraphClient | undefined` is the
     * ordinary way to declare something assigned later, and it is exactly as
     * definite as the bare form. Only unwrapped when ONE member is a real type:
     * `A | B` genuinely could be either, and picking one would be a guess.
     */
    const named = (typeNode: Node | undefined): string | undefined => {
      if (!typeNode) return undefined;

      if (Node.isUnionTypeNode(typeNode)) {
        const real = typeNode.getTypeNodes().filter((t) => {
          const text = t.getText();
          return text !== 'undefined' && text !== 'null';
        });
        return real.length === 1 ? named(real[0]) : undefined;
      }

      if (!Node.isTypeReference(typeNode)) return undefined;
      const name = typeNode.getTypeName();
      return Node.isIdentifier(name) ? name.getText() : undefined;
    };

    const annotated = (node: { getTypeNode(): Node | undefined }): string | undefined =>
      named(node.getTypeNode());

    for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initializer = variable.getInitializer();
      if (initializer && Node.isNewExpression(initializer)) {
        const constructed = initializer.getExpression();
        if (Node.isIdentifier(constructed)) bind(variable.getName(), constructed.getText());
        continue;
      }
      // `let client: GraphClient | undefined` — assigned later, but its type is
      // written down right here.
      bind(variable.getName(), annotated(variable));
    }

    // `function run(client: GraphClient)` — the same fact, on a parameter.
    for (const parameter of file.getDescendantsOfKind(SyntaxKind.Parameter)) {
      const name = parameter.getNameNode();
      if (Node.isIdentifier(name)) bind(name.getText(), annotated(parameter));
    }

    if (byName.size) instancesByFile.set(rel(file), byName);
  }

  // ---- imports -----------------------------------------------------------
  const imports: ImportEdge[] = [];
  for (const file of sourceFiles) {
    const filePath = rel(file);
    const fromKey = nodeKey(repoId, 'file', filePath);
    for (const decl of file.getImportDeclarations()) {
      // Resolved from our own tables — `getModuleSpecifierSourceFile()` goes
      // through the compiler's module resolver and was costing a checker call
      // per import.
      const target = resolver.resolveModuleFrom(filePath, decl.getModuleSpecifierValue());
      if (!target || target === 'external') continue;
      imports.push({ fromFileKey: fromKey, toFileKey: nodeKey(repoId, 'file', target) });
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
  let callSitesNeedingTypes = 0;

  for (const file of sourceFiles) {
    const filePath = rel(file);

    // Routes: Next.js App Router puts handlers in app/**/route.ts, exported
    // under the HTTP method name.
    //
    // Read from our own export tables, NOT `getExportedDeclarations()`. That is
    // a type-checker API, and on 49 route files it cost 13.7 SECONDS — most of
    // the whole analysis. The tables answer the same question from syntax.
    //
    // It still follows the alias, which is what matters here. A real Next.js
    // pattern is one handler serving every verb:
    //
    //   const handler = async (req) => { … }
    //   export { handler as DELETE, handler as GET, handler as POST };
    //
    // Keying the route off the EXPORTED name would invent `#GET`, which no
    // function node carries, and the edge would point at nothing.
    if (/(^|\/)app\/.*\/route\.tsx?$/.test(filePath)) {
      const symbols = tables.get(filePath);
      for (const [name, binding] of symbols?.exports ?? []) {
        if (!HTTP_METHODS.has(name)) continue;

        const handlerKey = binding.local
          ? symbols?.locals.get(binding.local)
          : repoKey(resolver.resolve(filePath, name));
        if (!handlerKey) continue;

        routes.push({
          key: nodeKey(repoId, 'route', `${name} ${routePathFor(filePath)}`),
          method: name,
          path: routePathFor(filePath),
          handlerKey,
          file: filePath,
          line: lineByKey.get(handlerKey) ?? 1,
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

        const targetKey = repoKey(resolver.resolve(filePath, tag.getText()));
        const enclosingKey = enclosingFunctionKey(element, keyByDeclaration);
        if (targetKey && enclosingKey && enclosingKey !== targetKey) {
          calls.push({
            fromKey: enclosingKey,
            toKey: targetKey,
            file: filePath,
            line: element.getStartLineNumber(),
            viaRender: true,
          });
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

      const targetKey = resolveCallTarget(call, {
        file: filePath,
        resolver,
        instances: instancesByFile.get(filePath),
      });
      if (targetKey === 'external') {
        callSitesExternal++;
        continue;
      }
      if (targetKey === 'needs-types') {
        // `obj.method()` on a value whose type only the checker knows. Counted
        // rather than guessed — see resolveCallTarget.
        callSitesNeedingTypes++;
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

    // `new Foo()` runs Foo's constructor, but a NewExpression is not a
    // CallExpression, so none of this was ever visited. The edge has to point at
    // the CONSTRUCTOR rather than the class: a class node is a Type, and a
    // Function -> Type call edge is discarded by the consistency pass below.
    for (const created of file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const expression = created.getExpression();
      if (!Node.isIdentifier(expression)) continue;

      callSitesTotal++;
      const enclosingKey = enclosingFunctionKey(created, keyByDeclaration);
      if (!enclosingKey) continue;

      const constructed = resolver.resolveMember(filePath, expression.getText(), 'constructor');
      if (constructed.kind === 'external') {
        callSitesExternal++;
        continue;
      }
      // No constructor node means the class declares none — nothing to point at,
      // and inventing an edge to the class would be an approximation (rule 1).
      if (constructed.kind !== 'repo') {
        callSitesUnresolved++;
        continue;
      }

      callSitesResolvedInRepo++;
      if (enclosingKey !== constructed.key) {
        calls.push({
          fromKey: enclosingKey,
          toKey: constructed.key,
          file: filePath,
          line: created.getStartLineNumber(),
        });
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

    /** Record a resolved mention, or count it as unresolved. Never guess. */
    const mention = (from: string, resolution: Resolution, line: number) => {
      const targetKey = repoKey(resolution);
      if (!targetKey) {
        typeRefsUnresolved++;
        return;
      }
      if (targetKey === from) return;
      typeRefsResolved++;
      references.push({ fromKey: from, toKey: targetKey, file: filePath, line });
    };

    for (const reference of file.getDescendantsOfKind(SyntaxKind.TypeReference)) {
      const nameNode = reference.getTypeName();

      const enclosingKey = enclosingFunctionKey(reference, keyByDeclaration);
      if (!enclosingKey) continue; // a type used outside any function is not an edge we can anchor

      if (Node.isIdentifier(nameNode)) {
        mention(enclosingKey, resolver.resolve(filePath, nameNode.getText()), reference.getStartLineNumber());
        continue;
      }

      // `Prisma.Vendor` — a qualified name, which was skipped WITHOUT being
      // counted, so the stats claimed a cleaner resolution rate than we had.
      if (Node.isQualifiedName(nameNode)) {
        const left = nameNode.getLeft();
        if (!Node.isIdentifier(left)) {
          typeRefsUnresolved++;
          continue;
        }
        mention(
          enclosingKey,
          resolver.resolveNamespaceMember(filePath, left.getText(), nameNode.getRight().getText()),
          reference.getStartLineNumber(),
        );
      }
    }

    // `class A extends B` and `interface A extends B`.
    //
    // A base type is written as an ExpressionWithTypeArguments, never a
    // TypeReference, so inheritance — the strongest relationship one type can
    // have with another — produced no edge at all.
    for (const heritage of file.getDescendantsOfKind(SyntaxKind.ExpressionWithTypeArguments)) {
      const expression = heritage.getExpression();
      if (!Node.isIdentifier(expression)) continue;

      const enclosingKey = enclosingFunctionKey(heritage, keyByDeclaration);
      if (!enclosingKey) continue;

      mention(enclosingKey, resolver.resolve(filePath, expression.getText()), heritage.getStartLineNumber());
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

  // Containment edges join every parent to the functions declared inside it.
  // Added here, after both ends are known to exist, so the consistency pass
  // below still gets the final say on whether each end was actually emitted.
  calls.push(...containment);

  const callsBefore = calls.length;
  const touchesBefore = touches.length;
  const routesBefore = routes.length;
  const importsBefore = imports.length;

  /**
   * A partial read cannot judge whether an endpoint exists.
   *
   * This pass drops edges whose ends were not emitted, which is right for a full
   * read and catastrophic for a partial one: when only two files are parsed,
   * EVERY edge leaving those files points at a function this run never emitted,
   * so all of them look dangling and the whole cross-file graph disappears.
   *
   * The caller merges these facts with the previous run's and applies the same
   * check against the complete picture — see `dropDanglingEdges` in
   * incremental.ts. Skipping it here is what lets that work.
   */
  const partial = options.only !== undefined;
  const keep = <T>(rows: T[], predicate: (row: T) => boolean) => (partial ? rows : rows.filter(predicate));

  const keptCalls = keep(calls, (c) => functionKeys.has(c.fromKey) && functionKeys.has(c.toKey));
  const keptTouches = keep(touches, (t) => functionKeys.has(t.fromKey) && modelKeys.has(t.modelKey));
  const keptRoutes = keep(routes, (r) => functionKeys.has(r.handlerKey));
  const keptImports = keep(imports, (i) => fileKeys.has(i.fromFileKey) && fileKeys.has(i.toFileKey));
  // A reference can start at a function OR a type (one interface extending
  // another), and must land on a type we emitted.
  const referencesBefore = references.length;
  const keptReferences = keep(
    references,
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
    symbols: tables,
    stats: {
      filesScanned: sourceFiles.length,
      callSitesTotal,
      callSitesResolvedInRepo,
      callSitesExternal,
      callSitesUnresolved,
      callSitesNeedingTypes,
      typeRefsResolved,
      typeRefsUnresolved,
      edgesDropped,
      duplicateNames: declarationStats.duplicateNames,
      durationMs: Date.now() - started,
    },
  };
}

// ---------------------------------------------------------------- internals

/** Glob every source file in the tree, ignoring any tsconfig. */
function globAllSources(root: string): Project {
  const project = new Project({ skipFileDependencyResolution: true });
  project.addSourceFilesAtPaths([
    `${root}/**/*.{ts,tsx}`,
    `!${root}/**/node_modules/**`,
    `!${root}/**/*.d.ts`,
  ]);
  return project;
}

/**
 * How many source files actually exist on disk.
 *
 * Used to check that whichever tsconfig we picked really describes the project,
 * rather than one corner of it.
 */
function countSourcesOnDisk(root: string): number {
  let total = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) total++;
    }
  };
  walk(root);
  return total;
}

/** Below this share of the tree, a tsconfig is describing one corner of a monorepo. */
const MIN_TSCONFIG_COVERAGE = 0.6;

/**
 * A project holding exactly these repo-relative files, and nothing else.
 *
 * It still loads the tsconfig — for its COMPILER OPTIONS, not its file list.
 * Without them there are no `paths` aliases, so every `@/lib/…` import fails to
 * resolve and the edges through it vanish. That is not a small loss on a Next.js
 * codebase: it silently cost 178 calls and 53 imports on a real repository, and
 * the demo could never have caught it because the demo uses no aliases.
 */
function projectFor(root: string, only: string[]): Project {
  const tsconfig = TSCONFIG_CANDIDATES
    .map((p) => path.join(root, p))
    .find((p) => fs.existsSync(p));

  const project = tsconfig
    ? new Project({
        tsConfigFilePath: tsconfig,
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
      })
    : new Project({ skipFileDependencyResolution: true });

  for (const rel of only) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) project.addSourceFileAtPath(full);
  }
  return project;
}

function loadProject(root: string, options: AnalyzeOptions): Project {
  const tsconfig = TSCONFIG_CANDIDATES
    .map((p) => path.join(root, p))
    .find((p) => fs.existsSync(p));

  if (tsconfig) {
    const project = new Project({
      tsConfigFilePath: tsconfig,
      skipAddingFilesFromTsConfig: false,
      // Nothing here calls the type checker any more, so the node_modules type
      // graph is dead weight: measured 11.3s to load and it changed no in-repo
      // resolution at all.
      skipFileDependencyResolution: true,
    });

    /**
     * A monorepo has no tsconfig at its root, and the fallbacks describe ONE
     * workspace.
     *
     * Measured on a real 4,976-file monorepo with no root tsconfig: the second
     * candidate, `apps/web/tsconfig.json`, was found and Ichor analysed 907
     * files — 18% of the codebase. Everything in the other workspaces was
     * invisible, so an agent could rewrite any of it unchallenged, and nothing
     * about that looked like a failure. Covering a fraction of a repository
     * while appearing to cover all of it is the worst way to be wrong.
     */
    const covered = project
      .getSourceFiles()
      .filter((f) => !f.getFilePath().includes('node_modules') && !f.getFilePath().endsWith('.d.ts'))
      .length;
    const onDisk = countSourcesOnDisk(root);

    if (onDisk === 0 || covered / onDisk >= MIN_TSCONFIG_COVERAGE) return project;
    // Otherwise fall through and take the whole tree.
  }

  // No usable tsconfig: glob the sources. Resolution is weaker without `paths`
  // aliases, which the unresolved counts in the stats will show.
  return globAllSources(root);
}

interface DeclaredFunction {
  name: string;
  node: Node;
  /**
   * Extra nodes that belong to this same function.
   *
   * `const C = memo(() => …)` declares one function across two nodes: the
   * variable carries the name, the arrow carries the body. Both must map to the
   * key or every call inside the body loses its source.
   */
  bodyNodes?: Node[];
  exported: boolean;
  /** Name of the function this one is declared inside, if any. */
  parent?: string;
}

/** Things we chose not to record. Counted, never silently dropped (rule 2). */
export interface DeclarationStats {
  /** Two declarations in one file wanting the same key — e.g. a static and an instance method. */
  duplicateNames: number;
}

/**
 * Every named function in a file.
 *
 * "Named" is broader than it looks. A function does not have to be written as
 * `function foo()` to be a thing an agent edits and a thing worth challenging an
 * edit against — and every shape missed here is worse than a wrong boundary,
 * because Ichor cannot question a change to code it does not know exists.
 *
 * Measured on a real React product: the three shapes this used to cover missed
 * object-literal methods, class property arrows, getters, setters, constructors,
 * anonymous default exports, and every component wrapped in `memo()` or
 * `forwardRef()` — a large share of the components in the codebase.
 *
 * Anonymous callbacks are still skipped. `items.map(x => …)` has no stable
 * identity, so a node for it could not survive the next edit.
 */
function declaredFunctions(file: SourceFile, stats: DeclarationStats): DeclaredFunction[] {
  const found: DeclaredFunction[] = [];
  const taken = new Set<string>();

  const add = (name: string, node: Node, exported: boolean, bodyNodes?: Node[], parent?: string) => {
    if (taken.has(name)) {
      stats.duplicateNames++;
      return;
    }
    taken.add(name);
    found.push({ name, node, exported, bodyNodes, parent });
  };

  /**
   * Functions declared inside other functions, named `outer.inner`.
   *
   * These are where the work is in React code — `const handleSubmit = () => …`
   * inside a component is precisely the thing an agent edits. Without them every
   * call made in a handler was credited to the whole component, so an edit deep
   * inside one looked identical to an edit anywhere else in the file.
   *
   * Nothing here can be reached from outside its parent, so `exported` is false
   * regardless of what the parent says.
   */
  const addNested = (container: Node, prefix: string) => {
    container.forEachDescendant((node, traversal) => {
      let name: string | undefined;

      if (Node.isFunctionDeclaration(node) && node.hasBody()) {
        name = node.getName();
      } else if (Node.isVariableDeclaration(node)) {
        const initializer = node.getInitializer();
        if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
          name = node.getName();
        }
      }
      if (!name) return;

      const qualified = `${prefix}.${name}`;
      add(qualified, node, false, undefined, prefix);
      // Recurse ourselves so deeper functions get the full chain, then stop the
      // outer walk descending into what we just handled.
      addNested(node, qualified);
      traversal.skip();
    });
  };

  for (const fn of file.getFunctions()) {
    // An overload SIGNATURE has no body, and would take the key its
    // implementation needs — leaving the real function invisible.
    if (!fn.hasBody()) continue;

    const name = fn.getName();
    if (name) {
      add(name, fn, isExported(fn));
      addNested(fn, name);
    } else if (fn.isDefaultExport()) {
      // `export default function () {}` — no name, but very much a function.
      add('default', fn, true);
      addNested(fn, 'default');
    }
  }

  for (const variable of file.getVariableDeclarations()) {
    const initializer = variable.getInitializer();
    if (!initializer) continue;
    const name = variable.getName();
    const exported = isExported(variable);

    if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
      add(name, variable, exported);
      addNested(variable, name);
      continue;
    }

    // `const api = { create() {}, list: () => {} }` — a namespace object, which
    // is how a great deal of non-class service code is written.
    //
    // Keying these as `api.create` is also what makes `api.create()` resolve:
    // `resolveMember` in symbols.ts answers `Owner.member` by looking up exactly
    // that string, so this closes part of the `obj.method()` gap for free.
    if (Node.isObjectLiteralExpression(initializer)) {
      for (const member of objectLiteralFunctions(initializer)) {
        add(`${name}.${member.name}`, member.node, exported);
        addNested(member.node, `${name}.${member.name}`);
      }
      continue;
    }

    // `const C = memo(() => …)`, `forwardRef(…)`, `withAuth(…)`, `useCallback(…)`.
    //
    // Deliberately NOT a list of known wrapper names. Any call handed a function
    // literal is, for our purposes, a declaration of that function under the
    // variable's name — and a hardcoded list of `memo`/`forwardRef` would miss
    // every project's own higher-order components, which is most of them.
    if (Node.isCallExpression(initializer)) {
      const inner = initializer
        .getArguments()
        .find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument));
      if (inner) {
        add(name, variable, exported, [inner]);
        addNested(inner, name);
      }
    }
  }

  // `export default () => {}` and `export default function () {}` reached as an
  // export assignment rather than a declaration.
  for (const assignment of file.getExportAssignments()) {
    if (assignment.isExportEquals()) continue;
    const expression = assignment.getExpression();
    if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
      add('default', assignment, true, [expression]);
    }
  }

  for (const cls of file.getClasses()) {
    // An anonymous default-exported class is still reachable, as `default`.
    const className = cls.getName() ?? 'default';
    const classExported = isExported(cls);
    /** A private member cannot be reached from outside, whatever the class says. */
    const reachable = (scope: string | undefined) => classExported && scope !== 'private';

    for (const method of cls.getMethods()) {
      const name = `${className}.${method.getName()}`;
      add(name, method, reachable(method.getScope()));
      addNested(method, name);
    }
    // Both accessors of a property share one name; the first wins and the second
    // is counted rather than dropped in silence.
    for (const accessor of [...cls.getGetAccessors(), ...cls.getSetAccessors()]) {
      add(`${className}.${accessor.getName()}`, accessor, reachable(accessor.getScope()));
    }
    for (const constructor of cls.getConstructors()) {
      add(`${className}.constructor`, constructor, classExported);
    }
    // `class A { handle = () => {} }` — extremely common for React handlers, and
    // until now every call inside one was attributed to the CLASS node, which is
    // a Type. Those edges were dropped at write time for pointing at the wrong
    // kind of node.
    for (const property of cls.getProperties()) {
      const initializer = property.getInitializer();
      if (!initializer) continue;
      if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
        const name = `${className}.${property.getName()}`;
        add(name, property, reachable(property.getScope()));
        addNested(property, name);
      }
    }
  }

  return found;
}

/** Function-valued members of an object literal, both `create() {}` and `list: () => {}`. */
function objectLiteralFunctions(object: Node): { name: string; node: Node }[] {
  if (!Node.isObjectLiteralExpression(object)) return [];
  const found: { name: string; node: Node }[] = [];

  for (const property of object.getProperties()) {
    if (Node.isMethodDeclaration(property)) {
      const name = property.getName();
      if (name) found.push({ name, node: property });
      continue;
    }
    if (Node.isPropertyAssignment(property)) {
      const initializer = property.getInitializer();
      if (!initializer) continue;
      if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
        const name = property.getName();
        if (name) found.push({ name, node: property });
      }
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

/**
 * Capitalised name in a .tsx file — good enough, and never load-bearing.
 *
 * Tested on the LAST segment: `Modal.handleClose` is a handler that happens to
 * live in a component, not a component itself.
 */
function isReactComponent(name: string, filePath: string): boolean {
  const own = name.slice(name.lastIndexOf('.') + 1);
  return filePath.endsWith('.tsx') && /^[A-Z]/.test(own);
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
/**
 * Which function does this call refer to?
 *
 * Answered from the symbol tables, never the type checker. The shapes that can
 * be resolved without inference, in order of how often they appear:
 *
 *   send(x)         a name — the import map has it                       96.5%
 *   this.foo()      a method on the class we are standing inside          1.0%
 *   api.foo()       a member of `import * as api from './api'`
 *
 * Everything else is `obj.method()` on a value whose type only the checker
 * knows. Those are NOT guessed — matching by method name would attach edges to
 * whatever else happens to share the name, which is exactly the fabricated
 * structure rule 1 exists to prevent. They are counted and reported instead.
 */
function resolveCallTarget(
  call: CallExpression,
  context: ResolveContext,
): string | 'external' | 'needs-types' | undefined {
  const expression = call.getExpression();

  if (Node.isIdentifier(expression)) {
    return fromResolution(context.resolver.resolve(context.file, expression.getText()));
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const receiver = expression.getExpression();
    const member = expression.getName();

    if (receiver.getKind() === SyntaxKind.ThisKeyword) {
      const className = enclosingClassName(expression);
      if (!className) return undefined;
      return fromResolution(context.resolver.resolveMember(context.file, className, member));
    }

    if (Node.isIdentifier(receiver)) {
      const receiverName = receiver.getText();

      const namespaced = context.resolver.namespaceModule(context.file, receiverName);
      if (namespaced) {
        return fromResolution(
          context.resolver.resolveNamespaceMember(context.file, receiverName, member),
        );
      }

      // A variable we watched being constructed: `new McpClient()` is a fact.
      const className = context.instances?.get(receiverName);
      if (className) {
        const found = context.resolver.resolveMember(context.file, className, member);
        if (found.kind === 'repo') return found.key;
      }
    }

    return 'needs-types';
  }

  return undefined;
}

interface ResolveContext {
  file: string;
  resolver: Resolver;
  /** Local name -> the class it was constructed from. `null` means ambiguous. */
  instances?: Map<string, string | null>;
}

function fromResolution(resolution: Resolution): string | 'external' | undefined {
  if (resolution.kind === 'repo') return resolution.key;
  if (resolution.kind === 'external') return 'external';
  return undefined;
}

/** The class a `this.foo()` call is standing inside, if any. */
function enclosingClassName(node: Node): string | undefined {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (Node.isClassDeclaration(current)) return current.getName();
    current = current.getParent();
  }
  return undefined;
}


/** First declaration that maps to a function we know about, ignoring library code. */
/** A resolution, reduced to a key when it landed inside the repository. */
function repoKey(resolution: Resolution): string | undefined {
  return resolution.kind === 'repo' ? resolution.key : undefined;
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
