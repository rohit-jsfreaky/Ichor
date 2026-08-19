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

import { Project, SyntaxKind, Node, ts } from 'ts-morph';
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

  const source = openRepo(root, options);
  const rel = (absolute: string) => normalisePath(absolute, root);

  // ---- files -------------------------------------------------------------
  const files: FileFact[] = source.paths.map((absolute) => ({
    key: nodeKey(repoId, 'file', rel(absolute)),
    path: rel(absolute),
  }));

  const functions: FunctionFact[] = [];
  const types: TypeFact[] = [];
  /** Parent -> nested function edges, merged into `calls` once both ends exist. */
  const containment: CallEdge[] = [];
  const declarationStats: DeclarationStats = { duplicateNames: 0, mergedDeclarations: 0 };

  // Start from the previous run's tables so an incremental parse can resolve
  // names that live in files it is not reading. Freshly parsed files overwrite
  // their own entries below.
  const tables = new Map<string, FileSymbols>(options.knownSymbols ?? []);
  const instancesByFile = new Map<string, Map<string, string | null>>();
  /**
   * Where every declaration sits, per file, sorted by start.
   *
   * This is what survives the parse tree being released. The second sweep needs
   * to know which function a call is written inside, and a character range
   * answers that as exactly as a node did — see `enclosingKeyAt`.
   */
  const spansByFile = new Map<string, DeclarationSpan[]>();
  /** Function key -> the human-readable strings written inside it. */
  const textByKey = new Map<string, string[]>();

  // ==== SWEEP ONE — what each file declares, on its own ====================
  //
  // Everything here is answerable from one file in isolation, and everything it
  // produces is strings. That is what lets the parse tree go before the next file
  // is opened, and it is the whole reason this is two sweeps rather than eight
  // passes over a repository held open all at once: 1,988 MB became about 300 MB,
  // and the ceiling moved from ~39 MB of TypeScript to somewhere nobody will
  // reach. See `docs/` and BUGS.md bug 10.
  for (const absolute of source.paths) {
    const filePath = rel(absolute);
    const file = source.read(absolute);
    try {
      const isTest = /\.(test|spec)\.tsx?$/.test(filePath);

      /**
       * Name -> key for this file, which is both the symbol table's `locals` and
       * what the next sweep resolves against.
       *
       * Functions first, then types, because that is the order the previous
       * shape built it in and a class declaring a same-named function would
       * otherwise land on a different key.
       */
      const locals = new Map<string, string>();
      const spans: DeclarationSpan[] = [];

      for (const decl of declaredFunctions(file, declarationStats)) {
        const key = nodeKey(repoId, 'function', filePath, decl.name);
        functions.push({
          key,
          name: decl.name,
          file: filePath,
          line: decl.node.getStartLineNumber(),
          endLine: decl.node.getEndLineNumber(),
          exported: decl.exported,
          isComponent: isReactComponent(decl.name, filePath),
          isTest,
        });
        locals.set(decl.name, key);
        spans.push({ start: decl.node.getStart(), end: decl.node.getEnd(), key });
        // A wrapped function lives across two nodes — `const C = memo(() => …)`
        // carries its name on the variable and its body on the arrow. Both ranges
        // lead to the key, or calls inside the body lose their source.
        for (const body of decl.bodyNodes ?? []) {
          spans.push({ start: body.getStart(), end: body.getEnd(), key });
        }

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

      for (const declared of declaredTypes(file, declarationStats)) {
        const key = nodeKey(repoId, 'type', filePath, declared.name);
        types.push({
          key,
          name: declared.name,
          kind: declared.kind,
          file: filePath,
          // The first declaration is where the type is reported to live.
          line: declared.nodes[0]!.getStartLineNumber(),
          exported: declared.exported,
        });
        locals.set(declared.name, key);
        // A span PER DECLARATION, all pointing at the one type. A merged
        // interface is still two places in the file, and a reference written
        // inside the second one has to attribute to the same node as the first
        // — merging must not cost attribution.
        for (const node of declared.nodes) {
          spans.push({ start: node.getStart(), end: node.getEnd(), key });
        }
      }

      // Sorted once here so every lookup in the second sweep is a binary search.
      spans.sort((a, b) => a.start - b.start);
      spansByFile.set(filePath, spans);

      /**
       * Attribute each human-readable string to the function containing it.
       *
       * ONE callback walk, not two `getDescendantsOfKind` calls. Those each build an
       * array of ts-morph wrappers for every literal in the file, and on top of the
       * walks already happening here that cost real memory: opentui went from 384 MB
       * to 1,097 MB and papermark's read time from 10.8s to 18.2s. `forEachDescendant`
       * visits the same nodes without retaining an array of them.
       *
       * Strings outside any function — a module-level table of messages — are dropped:
       * there is nothing to anchor them to.
       */
      file.forEachDescendant((node) => {
        if (
          !Node.isStringLiteral(node) &&
          !Node.isNoSubstitutionTemplateLiteral(node)
        ) {
          return;
        }
        const value = node.getLiteralValue();
        if (typeof value !== 'string' || !isUserFacingText(value)) return;

        const owner = enclosingKeyAt(node.getStart(), spans);
        if (!owner) return;

        const found = textByKey.get(owner);
        if (!found) {
          textByKey.set(owner, [value.slice(0, USER_TEXT_MAX_CHARS)]);
        } else if (found.length < USER_TEXT_PER_FUNCTION) {
          found.push(value.slice(0, USER_TEXT_MAX_CHARS));
        }
      });

      tables.set(filePath, symbolTableFor(file, filePath, locals));

      const instances = declaredInstances(file);
      if (instances.size) instancesByFile.set(filePath, instances);
    } finally {
      source.release(file);
    }
  }

  // ---- everything the second sweep resolves against -----------------------
  const aliases = parseAliases(
    source.compilerOptions.paths as Record<string, string[]> | undefined,
    source.compilerOptions.baseUrl ? normalisePath(source.compilerOptions.baseUrl, root) : '',
  );
  const knownFiles = new Set([...tables.keys(), ...files.map((f) => f.path)]);
  const resolver = createResolver(tables, knownFiles, aliases);

  /** Where each declaration sits, so a route can report its handler's line. */
  const lineByKey = new Map<string, number>();
  for (const fact of [...functions, ...types]) lineByKey.set(fact.key, fact.line);

  const { models, fields } = parsePrismaSchema(root);
  const modelKeyByName = new Map(models.map((m) => [m.name.toLowerCase(), m.key]));

  /**
   * Schema files become File nodes that DECLARE their models.
   *
   * A `.prisma` file is not TypeScript, so nothing above ever emitted one — and a
   * file absent from the graph was challenged on every edit, including one adding
   * the very field the task was about. It IS structure we already read: the
   * models are parsed, and this is the edge that says where they came from.
   */
  for (const schemaFile of new Set(models.map((m) => m.file))) {
    if (files.some((f) => f.path === schemaFile)) continue;
    files.push({ key: nodeKey(repoId, 'file', schemaFile), path: schemaFile });
  }

  // ==== SWEEP TWO — how files reach each other =============================
  const imports: ImportEdge[] = [];
  /** Non-TypeScript files that TypeScript imports — JSON, CSS, SVG. */
  const assets = new Set<string>();
  const calls: CallEdge[] = [];
  const touches: TouchEdge[] = [];
  const routes: RouteFact[] = [];
  const references: ReferenceEdge[] = [];

  let callSitesTotal = 0;
  let callSitesResolvedInRepo = 0;
  let callSitesExternal = 0;
  let callSitesUnresolved = 0;
  let callSitesNeedingTypes = 0;
  let typeRefsResolved = 0;
  let typeRefsUnresolved = 0;

  for (const absolute of source.paths) {
    const filePath = rel(absolute);
    const file = source.read(absolute);
    try {
      /**
       * Where this file's declarations sit, from the first sweep.
       *
       * Scoped to one file, which is not a compromise: the question is always
       * "which declaration is this code written inside", and that never leaves
       * the file the code is in.
       */
      const spans = spansByFile.get(filePath) ?? [];
      const enclosing = (node: Node) => enclosingKeyAt(node.getStart(), spans);

      // ---- imports --------------------------------------------------------
      const fromFileKey = nodeKey(repoId, 'file', filePath);
      for (const decl of file.getImportDeclarations()) {
        const specifier = decl.getModuleSpecifierValue();
        // Resolved from our own tables — `getModuleSpecifierSourceFile()` goes
        // through the compiler's module resolver and was costing a checker call
        // per import.
        const target = resolver.resolveModuleFrom(filePath, specifier);
        if (target && target !== 'external') {
          imports.push({ fromFileKey, toFileKey: nodeKey(repoId, 'file', target) });
          continue;
        }

        /**
         * A file TypeScript imports that TypeScript cannot read.
         *
         * `import en from './locales/en.json'` and `import styles from './x.css'`
         * are real dependencies, and discarding them left those files with no place
         * in the graph at all — so every edit to one was judged with no structure to
         * judge it by. Phase 3.4 stopped that being a false alarm; this is what turns
         * the resulting silence into a citation, because now the graph can say WHICH
         * code depends on the file being changed.
         *
         * Only relative specifiers that really exist on disk. A bare package name is
         * somebody else's code, and inventing a node for a path that is not there
         * would be exactly the fabricated structure rule 1 forbids.
         */
        const asset = resolveAsset(root, filePath, specifier);
        if (!asset) continue;
        assets.add(asset);
        imports.push({ fromFileKey, toFileKey: nodeKey(repoId, 'file', asset) });
      }

      // ---- routes ---------------------------------------------------------
      //
      // Next.js App Router puts handlers in app/**/route.ts, exported under the
      // HTTP method name.
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

      // ---- rendered components -------------------------------------------
      //
      // React components are used as <Component />, which is a JSX element and
      // not a CallExpression — so without this, every page->component edge is
      // missing and UI entry points look disconnected from the code they drive.
      for (const kind of [SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxOpeningElement] as const) {
        for (const element of file.getDescendantsOfKind(kind)) {
          const tag = element.getTagNameNode();
          // Lowercase tags are intrinsic elements (<div>), not our components.
          if (!Node.isIdentifier(tag) || !/^[A-Z]/.test(tag.getText())) continue;

          const targetKey = repoKey(resolver.resolve(filePath, tag.getText()));
          const enclosingKey = enclosing(element);
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

      // ---- calls and prisma touches ---------------------------------------
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        callSitesTotal++;

        const enclosingKey = enclosing(call);
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
        const enclosingKey = enclosing(created);
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

      // ---- type references -------------------------------------------------
      //
      // Which function mentions which type — in a parameter, a return, an
      // annotation, a cast. Resolved through the compiler exactly like a call, so
      // `Vendor` here is THE `Vendor` declared over there and not merely a word
      // that matches. Unresolved mentions are counted, never guessed (rules 1, 2).

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

        const enclosingKey = enclosing(reference);
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

        const enclosingKey = enclosing(heritage);
        if (!enclosingKey) continue;

        mention(enclosingKey, resolver.resolve(filePath, expression.getText()), heritage.getStartLineNumber());
      }
    } finally {
      source.release(file);
    }
  }

  /**
   * Imported assets become File nodes too.
   *
   * Added after the sweep because they are only discovered by resolving imports.
   * They declare nothing — there is no `DECLARES` edge — so all the graph knows
   * about them is which files import them, which is exactly the question that
   * matters when one is edited.
   */
  const known = new Set(files.map((f) => f.path));
  for (const asset of assets) {
    if (known.has(asset)) continue;
    files.push({ key: nodeKey(repoId, 'file', asset), path: asset });
    known.add(asset);
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
  // Attached after the sweep rather than during it: a function's strings are only
  // known once its whole body has been walked.
  for (const fn of functions) {
    const text = textByKey.get(fn.key);
    if (text) fn.text = text;
  }

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
      filesScanned: source.paths.length,
      callSitesTotal,
      callSitesResolvedInRepo,
      callSitesExternal,
      callSitesUnresolved,
      callSitesNeedingTypes,
      typeRefsResolved,
      typeRefsUnresolved,
      edgesDropped,
      duplicateNames: declarationStats.duplicateNames,
      mergedDeclarations: declarationStats.mergedDeclarations,
      durationMs: Date.now() - started,
    },
  };
}

/**
 * What a file imports and exports, from its syntax alone.
 *
 * `locals` comes from the caller because the declarations were already found —
 * finding them twice inside one sweep would be the cost this restructure exists
 * to avoid.
 */
function symbolTableFor(
  file: SourceFile,
  filePath: string,
  locals: Map<string, string>,
): FileSymbols {
  const symbols: FileSymbols = {
    file: filePath,
    locals,
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
  // Unexported declarations are recorded too. Refusing to resolve a name because
  // it looked private would silently drop real edges — far worse than resolving
  // one a stricter reading would have kept private.
  for (const name of symbols.locals.keys()) symbols.exports.set(name, { local: name });

  // Default exports.
  //
  // Without these, `import AppLayout from './layout'` resolves to nothing — the
  // import binds the name `default`, and nothing ever registered it. On a React
  // codebase that is most components: one layout alone accounted for 74 lost
  // edges, and the total was 726.
  for (const declaration of [...file.getFunctions(), ...file.getClasses()]) {
    const name = declaration.getName();
    if (name && hasDefaultKeyword(declaration)) symbols.exports.set('default', { local: name });
  }
  // `export default Foo` as a statement of its own.
  for (const assignment of file.getExportAssignments()) {
    if (assignment.isExportEquals()) continue;
    const expression = assignment.getExpression();
    if (Node.isIdentifier(expression)) symbols.exports.set('default', { local: expression.getText() });
  }

  for (const decl of file.getExportDeclarations()) {
    const from = decl.getModuleSpecifierValue();
    if (decl.isNamespaceExport() && from) {
      symbols.starExports.push(from);
      continue;
    }
    for (const named of decl.getNamedExports()) {
      const exportedAs = named.getAliasNode()?.getText() ?? named.getName();
      symbols.exports.set(
        exportedAs,
        from ? { fromModule: from, imported: named.getName() } : { local: named.getName() },
      );
    }
  }

  return symbols;
}

/**
 * Local names bound to a class, so `client.request()` can be resolved.
 *
 * `const client = new McpClient(); client.request()` is a method call, but its
 * type needs no inference at all: `new McpClient()` says so outright. Without
 * this, every call through a class instance is lost — 18% of the edges in this
 * repository, which is class-heavy.
 *
 * A name bound to two different classes in one file is dropped rather than picked
 * between. Guessing which one a call meant would fabricate an edge, and a missed
 * edge is always cheaper than a wrong one (rule 1).
 */
function declaredInstances(file: SourceFile): Map<string, string | null> {
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

  return byName;
}

// ---------------------------------------------------------------- internals

/** Below this share of the tree, a tsconfig is describing one corner of a monorepo. */
const MIN_TSCONFIG_COVERAGE = 0.6;

/**
 * The repository, opened one file at a time.
 *
 * Everything about reading files lives behind this, because the rule the rest of
 * the analysis has to obey is simply "read, use, release" — and that rule is the
 * whole memory fix. Holding the repository open cost 1,988 MB on a 37.8 MB
 * codebase and put the ceiling at roughly 39 MB of TypeScript; this holds one
 * file at a time and stays near 300 MB whatever the repo's size.
 */
interface RepoSource {
  /** Absolute paths, in the order the analysis will read them. */
  paths: string[];
  /** From the tsconfig, for its `paths` aliases — not for its file list. */
  compilerOptions: ts.CompilerOptions;
  read(absolute: string): SourceFile;
  release(file: SourceFile): void;
}

/**
 * A tsconfig's file list and options, WITHOUT parsing any of the files.
 *
 * `new Project({ tsConfigFilePath })` reads and parses everything the config
 * names — 185 MB and 1.8s on papermark before a single fact is extracted, and
 * five times that on a large monorepo. Asking TypeScript to resolve the config
 * gives the same two answers for the cost of reading some JSON, and
 * `getParsedCommandLineOfConfigFile` follows `extends` chains, which a plain
 * `readConfigFile` does not.
 */
function readTsConfig(
  tsconfigPath: string,
): { fileNames: string[]; options: ts.CompilerOptions } | undefined {
  try {
    const host: ts.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        /* a broken config falls back to walking the tree */
      },
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, host);
    return parsed ? { fileNames: parsed.fileNames, options: parsed.options } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A relative import that points at a real non-TypeScript file.
 *
 * Returns the repo-relative path, or undefined if the specifier is a package, is
 * outside the repo, or names nothing on disk. Only ever answers about a file that
 * genuinely exists: a node for a path that does not would be invented structure.
 */
function resolveAsset(root: string, fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  // A TypeScript module would already have resolved; anything left with a source
  // extension is a broken import, not an asset.
  if (/\.(tsx?|jsx?|mjs|cjs)$/.test(specifier)) return undefined;
  if (!/\.[a-z0-9]+$/i.test(specifier)) return undefined; // no extension: a module path

  const relative = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
  // `..` that climbs out of the repo is not ours to describe.
  if (relative.startsWith('..')) return undefined;

  return fs.existsSync(path.join(root, relative)) ? relative : undefined;
}

/** Files the analysis reads: our own source, never a dependency or a declaration. */
const isOwnSource = (file: string) => !file.includes('node_modules') && !file.endsWith('.d.ts');

function openRepo(root: string, options: AnalyzeOptions): RepoSource {
  const tsconfigPath = TSCONFIG_CANDIDATES.map((p) => path.join(root, p)).find((p) =>
    fs.existsSync(p),
  );
  const tsconfig = tsconfigPath ? readTsConfig(tsconfigPath) : undefined;

  let paths: string[];
  let compilerOptions: ts.CompilerOptions = {};

  if (options.only) {
    // An incremental run reads exactly the files it was handed. Resolution still
    // sees every other file, through `knownSymbols`.
    //
    // Filtered to TypeScript: a changed `.prisma` file arrives here too, since it
    // is a File node in the graph, and handing it to ts-morph would parse a schema
    // as TypeScript. It needs no parsing — `parsePrismaSchema` re-reads every
    // schema from disk on every run, so its models are always current.
    paths = options.only
      .filter((relative) => /\.tsx?$/.test(relative) && !relative.endsWith('.d.ts'))
      .map((relative) => path.join(root, relative))
      .filter((full) => fs.existsSync(full));
    // The tsconfig is still read here, for its COMPILER OPTIONS. Without them
    // there are no `paths` aliases, so every `@/lib/…` import fails to resolve
    // and the edges through it vanish — measured at 178 calls and 53 imports on
    // a real Next.js repository, and invisible on the demo, which uses none.
    compilerOptions = tsconfig?.options ?? {};
  } else if (tsconfig) {
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
    const covered = tsconfig.fileNames.filter(isOwnSource);
    const onDisk = sourceFilesUnder(root);

    if (onDisk.length === 0 || covered.length / onDisk.length >= MIN_TSCONFIG_COVERAGE) {
      paths = covered;
      compilerOptions = tsconfig.options;
    } else {
      // Take the whole tree instead. Resolution is weaker without the aliases,
      // which the unresolved counts in the stats will show.
      paths = onDisk;
    }
  } else {
    paths = sourceFilesUnder(root);
  }

  const project = new Project({
    compilerOptions,
    skipFileDependencyResolution: true,
    // Nothing here calls the type checker, so `lib.dom.d.ts` and friends are
    // several megabytes of dead weight.
    skipLoadingLibFiles: true,
  });

  return {
    paths,
    compilerOptions,
    read: (absolute) => project.addSourceFileAtPath(absolute),
    release: (file) => {
      // Both are needed. `forget()` drops ts-morph's wrapper nodes — the layer
      // that makes up most of the memory, since every node walked gets one — and
      // the project still holds the compiler's SourceFile until it is removed.
      file.forget();
      project.removeSourceFile(file);
    },
  };
}

/**
 * Every source file in the tree, found by walking it.
 *
 * NOT `addSourceFilesAtPaths(['**\/*.ts', '!**\/node_modules/**'])`. That
 * negation filters the RESULT; the traversal still descends into every
 * node_modules on the way, and on a pnpm monorepo `.pnpm` holds one directory per
 * version of every transitive dependency. Measured on better-auth: the glob ran
 * out of memory outright, while this walk found the same 1,319 files in 35ms.
 */
function sourceFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skipped before descending, not after. `.pnpm`, `.git` and `.next` are
      // each large enough on their own to decide the outcome.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(full);
    }
  };
  walk(root);
  return found;
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
  /**
   * Type declarations folded into an existing type of the same name.
   *
   * Not a loss like `duplicateNames` — these are declaration merges, and one node
   * for them is what the language actually means. Counted because a silent fold
   * and a silent drop look identical from the outside.
   */
  mergedDeclarations: number;
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
  const exportedNames = exportedByStatement(file);

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
      add(name, fn, isExported(fn, exportedNames));
      addNested(fn, name);
    } else if (hasDefaultKeyword(fn)) {
      // `export default function () {}` — no name, but very much a function.
      add('default', fn, true);
      addNested(fn, 'default');
    }
  }

  for (const variable of file.getVariableDeclarations()) {
    const initializer = variable.getInitializer();
    if (!initializer) continue;
    const name = variable.getName();
    const exported = isExported(variable, exportedNames);

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
    const classExported = isExported(cls, exportedNames);
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
  /**
   * Every declaration that contributes to this type, in source order.
   *
   * More than one is the normal case for a merged interface, not an error — see
   * `declaredTypes`. The first is where the type is reported to live; all of them
   * are spans a reference can be found inside.
   */
  nodes: Node[];
  exported: boolean;
}

/**
 * Named types declared at the top level of a file.
 *
 * Classes appear here as well as contributing their methods to
 * `declaredFunctions` — a class is both a thing you call into and a shape you
 * refer to, and a task can be about either.
 *
 * DECLARATION MERGING IS ONE TYPE, NOT TWO.
 *
 * TypeScript lets a name be declared more than once in a file and merges the
 * declarations into a single type — it is how you augment a module, and how a
 * library extends someone else's interface:
 *
 *   export interface Options { llmRegistry?: ModelRegistry }
 *   export interface Options extends ConfigInput {}          // the same Options
 *
 * Emitting one node per DECLARATION produced two nodes with the same id and
 * different `line`, which HydraDB rejects for the whole batch — one merged
 * interface anywhere in a repository made that repository impossible to index at
 * all. Observed on a real 1,396-file project, where exactly one name of 8,098
 * collided and took the entire graph down with it.
 *
 * So declarations are grouped by name, which is also simply what the language
 * says is true. The first declaration gives the type its location, and `exported`
 * is true when ANY declaration exports it — `interface X {}` followed by
 * `export interface X {}` is an exported type.
 *
 * The count of merges is reported rather than swallowed (rule 2), because a
 * number that quietly drops declarations is how a graph starts lying.
 */
function declaredTypes(file: SourceFile, stats: DeclarationStats): DeclaredType[] {
  const order: string[] = [];
  const byName = new Map<string, DeclaredType>();
  const exportedNames = exportedByStatement(file);

  const add = (name: string, kind: DeclaredType['kind'], node: Node) => {
    const exported = isExported(node, exportedNames);
    const existing = byName.get(name);
    if (existing) {
      // Same name, same file: one type with several declarations.
      existing.nodes.push(node);
      existing.exported = existing.exported || exported;
      stats.mergedDeclarations++;
      return;
    }
    order.push(name);
    byName.set(name, { name, kind, nodes: [node], exported });
  };

  for (const node of file.getInterfaces()) add(node.getName(), 'interface', node);
  for (const node of file.getTypeAliases()) add(node.getName(), 'alias', node);
  for (const node of file.getEnums()) add(node.getName(), 'enum', node);
  for (const node of file.getClasses()) {
    const name = node.getName();
    if (name) add(name, 'class', node);
  }

  return order.map((name) => byName.get(name)!);
}

/**
 * Names a file exports through a statement rather than a keyword.
 *
 *   export { foo, bar as baz }        foo and bar are exported
 *   export { thing } from './other'   NOT a local declaration — skipped
 *   export default foo                foo is exported
 *
 * The LOCAL name is what is recorded, not the alias: `export { foo as bar }` puts
 * the declaration named `foo` on the public surface, and looking for `bar` would
 * find nothing.
 */
function exportedByStatement(file: SourceFile): Set<string> {
  const names = new Set<string>();

  for (const declaration of file.getExportDeclarations()) {
    // A re-export names something in ANOTHER file. Counting it here would mark
    // an unrelated local declaration that happens to share the name.
    if (declaration.getModuleSpecifier()) continue;
    for (const spec of declaration.getNamedExports()) names.add(spec.getName());
  }

  for (const assignment of file.getExportAssignments()) {
    const expression = assignment.getExpression();
    if (Node.isIdentifier(expression)) names.add(expression.getText());
  }

  return names;
}

/**
 * Is this declaration part of the file's public surface?
 *
 * Answered from the syntax tree, and it has to be. ts-morph's own `isExported()`
 * falls through to `getSymbol()`, which builds the entire TypeScript Program,
 * which resolves every import into `node_modules` and loads the type definitions
 * of every dependency — for a question the `export` keyword already answers.
 *
 * Measured on a TWENTY-file package of a pnpm monorepo: 15,389 filesystem calls,
 * 7 seconds and 350 MB, most of it statting `kysely` and `type-fest` and walking
 * up the tree as far as the drive root. It is why `analyzeRepo` ran out of memory
 * on three of five real repositories while papermark, whose dependencies resolve
 * to far less, survived at 802 MB and looked fine.
 *
 * `scripts/exported-gate.mjs` holds the two answers side by side. They agree on
 * all 6,314 declarations across five codebases, and that gate is the reason this
 * is a rewrite rather than a guess — a wrong flag here does not crash anything,
 * it quietly changes which code counts as a codebase's public surface and
 * therefore which edits get challenged.
 */
function isExported(node: Node, exportedNames: Set<string>): boolean {
  const withKeywords = node as unknown as {
    hasExportKeyword?: () => boolean;
    hasDefaultKeyword?: () => boolean;
    getName?: () => string | undefined;
  };
  if (withKeywords.hasExportKeyword?.()) return true;
  if (withKeywords.hasDefaultKeyword?.()) return true;

  const name = withKeywords.getName?.();
  return name ? exportedNames.has(name) : false;
}

/**
 * `export default function foo() {}` — the keyword form only.
 *
 * ts-morph's `isDefaultExport()` has the same problem as `isExported()`: it
 * checks the keyword, then falls through to `getSymbol()`. The statement form,
 * `export default foo`, is read separately from `getExportAssignments()`.
 */
function hasDefaultKeyword(node: Node): boolean {
  return (node as unknown as { hasDefaultKeyword?: () => boolean }).hasDefaultKeyword?.() === true;
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

/**
 * How many human-readable strings to keep per function.
 *
 * A bound, because a codebase's strings dwarf its structure and this is a
 * supporting signal rather than the graph. Eight is enough for a task to find the
 * message it is about; keeping every literal in a 1,362-file repo would put tens of
 * megabytes of copy into `facts.json`, which is read on every prompt.
 */
const USER_TEXT_PER_FUNCTION = 8;

/** Longest snippet kept. Enough to match a phrase, not enough to store a document. */
const USER_TEXT_MAX_CHARS = 120;

/**
 * Does this string look like something a person reads?
 *
 * Deliberately narrow, because the point is to find the message a task names, and
 * every extra string is noise that dilutes the anchor scoring. A module specifier, a
 * CSS class list, an enum value and a URL are all strings and none of them is copy.
 *
 * The test is a SENTENCE shape: at least two words, mostly letters and spaces, and
 * no path or identifier punctuation. "Link has expired." passes. "text-sm font-bold",
 * "@/lib/utils" and "created_at" do not.
 */
function isUserFacingText(value: string): boolean {
  const text = value.trim();
  if (text.length < 8 || text.length > 400) return false;
  if (!/\s/.test(text)) return false; // one word is a key or a class name, not a message
  if (/[/\{}<>|=_$]/.test(text)) return false; // paths, templates, selectors, identifiers
  if (/^(https?:|data:|\.)/.test(text)) return false;

  const letters = text.replace(/[^a-zA-Z]/g, '').length;
  if (letters / text.length < 0.6) return false; // mostly punctuation or digits

  // Two or more real words. Tailwind class lists are many short tokens, so require
  // the average word to be word-shaped.
  const words = text.split(/\s+/).filter((w) => /^[a-zA-Z][a-zA-Z'’.,!?-]*$/.test(w));
  return words.length >= 2 && words.length >= text.split(/\s+/).length * 0.7;
}

/**
 * Where one declaration sits in its file, and which node it is.
 *
 * Character offsets rather than the node itself, because the node belongs to a
 * parse tree that was released at the end of the first sweep. Two numbers and a
 * string survive that; an AST does not.
 */
export interface DeclarationSpan {
  start: number;
  end: number;
  key: string;
}

/**
 * The function or type a piece of code sits inside, so an edge has a source.
 *
 * This used to walk UP the parent chain looking for a node in a map. That needed
 * the declarations found a second time, in the sweep that reads calls — and
 * finding them twice cost 72% more time on papermark, a regression introduced by
 * the very change that fixed the memory.
 *
 * Positions answer it without a second parse. Declarations nest exactly the way
 * their ranges do, so the innermost range containing a position IS the nearest
 * enclosing declaration — the same answer the parent walk gave, including the
 * `const C = memo(() => …)` case, where the arrow's range sits inside the
 * variable's and both carry C's key.
 *
 * `spans` must be sorted by `start` ascending.
 */
function enclosingKeyAt(position: number, spans: DeclarationSpan[]): string | undefined {
  // Last span beginning at or before this position.
  let low = 0;
  let high = spans.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (spans[middle]!.start <= position) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  // Walk back past siblings that closed before this position. The first span
  // still open is the innermost one containing it.
  for (let i = candidate; i >= 0; i--) {
    if (spans[i]!.end >= position) return spans[i]!.key;
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
