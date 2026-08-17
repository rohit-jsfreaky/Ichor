/**
 * The facts the analyzer produces.
 *
 * Extraction is pure: it reads source and returns this structure. Nothing here
 * touches HydraDB — that is `src/graph/write.ts`. Keeping the split means the
 * analyzer is testable against the demo fixture with no Docker running
 * (docs/ENGINEERING-RULES.md rule 5).
 *
 * Every node carries `file` and `line` so a challenge can cite its evidence.
 */

/** Where something is, for citing evidence to the developer. */
export interface SourceLocation {
  /** Repo-relative, POSIX separators. Machine-independent — see normalisePath. */
  file: string;
  line: number;
}

export interface FunctionFact extends SourceLocation {
  /** Stable key: `function:<file>#<name>` */
  key: string;
  /**
   * Human-readable strings written inside this function.
   *
   * Not structure, and never used to draw an edge — this is ANCHOR evidence, the
   * step that is already text matching. Without it a task named entirely by
   * user-facing copy has nothing to point at: *"the expired-link message says
   * 'Link has expired' — make it friendlier"* landed 393 functions away from the
   * two files that hold that string, because Ichor indexed declarations, calls and
   * types and not a word of what the code actually says.
   *
   * Bounded per function — see `USER_TEXT_PER_FUNCTION` in analyze.ts. A codebase's
   * strings are far bigger than its structure.
   */
  text?: string[];
  name: string;
  exported: boolean;
  /** True for React components — capitalised and returning JSX. */
  isComponent: boolean;
  /** True when declared in a *.test.ts / *.spec.ts file. */
  isTest: boolean;
  /**
   * Last line of the declaration.
   *
   * A function is a RANGE, not a point, and `line` alone cannot answer "which
   * function is this edit in?" — the question the ground-truth harness asks of
   * every line in a real commit's diff. With both ends, and nested functions
   * being visible, the owner of a line is the innermost range containing it.
   */
  endLine: number;
}

export interface FileFact {
  /** Stable key: `file:<path>` */
  key: string;
  path: string;
}

export interface RouteFact extends SourceLocation {
  /** Stable key: `route:<METHOD> <path>` */
  key: string;
  method: string;
  /** URL path derived from the App Router file location, e.g. /api/vendors */
  path: string;
  /** Key of the exported handler function. */
  handlerKey: string;
}

/**
 * A named type: an interface, type alias, enum or class.
 *
 * In TypeScript a large share of the structure is types, and Ichor recorded none
 * of it. Without these, a task like "add a status field to the Vendor type"
 * anchors to nothing in an app that has no Prisma schema to name `Vendor` for
 * us, and Ichor stays silent for the whole job.
 */
export interface TypeFact extends SourceLocation {
  /** Stable key: `type:<file>#<Name>` */
  key: string;
  name: string;
  kind: 'interface' | 'alias' | 'enum' | 'class';
  exported: boolean;
}

/**
 * A function that mentions a type — in a parameter, a return, an annotation.
 *
 * Resolved through the compiler like every other edge, so `Vendor` here is THE
 * `Vendor` that was declared over there, not merely something with the same name.
 */
export interface ReferenceEdge extends SourceLocation {
  fromKey: string;
  toKey: string;
}

export interface ModelFact {
  /** Stable key: `model:<name>` */
  key: string;
  name: string;
  /**
   * The schema file that declares it, repo-relative.
   *
   * Recorded so that editing `prisma/schema/link.prisma` can be understood as
   * changing the models in it. Without this the schema was a file Ichor knew
   * nothing about, and every schema edit was challenged — even one adding the
   * field the task was about.
   */
  file: string;
}

export interface FieldFact {
  /** Stable key: `field:<Model>.<field>` */
  key: string;
  model: string;
  name: string;
  type: string;
  isUnique: boolean;
  isId: boolean;
}

/** A resolved call from one function to another, both inside the repo. */
export interface CallEdge extends SourceLocation {
  fromKey: string;
  toKey: string;
  /**
   * True when this is `<Child />` rather than `child()`.
   *
   * Both are real edges, but they mean different things, and collapsing them was
   * measured to be the single largest cause of an over-wide task boundary. A
   * page component renders twenty unrelated widgets; treating that as "the page
   * depends on all twenty" lets a walk cross from a folder tree into a PDF
   * viewer's icons. See `renderStep` in scope/neighborhood.ts for the rule this
   * flag exists to support.
   */
  viaRender?: boolean;
  /**
   * True when the target is declared INSIDE the source — `handleSubmit` inside
   * `VendorForm`.
   *
   * Without this edge, making nested functions visible would cut the graph into
   * pieces: `VendorForm` and `VendorForm.handleSubmit` would be two unconnected
   * nodes, and a walk starting at the component could no longer reach what the
   * component actually does. A fragmented graph draws boundaries that are too
   * SMALL, which produces false challenges — worse than the imprecision this
   * whole workstream set out to fix.
   *
   * Containment is not distance: the handler is part of the component, so the
   * walk admits it at the same distance rather than one hop further out.
   */
  viaContains?: boolean;
}

/** A function reading or writing a Prisma model. */
export interface TouchEdge extends SourceLocation {
  fromKey: string;
  modelKey: string;
  /** findUnique, create, update, … */
  operation: string;
  /** Reads do not carry the same risk as writes; kept for future weighting. */
  isWrite: boolean;
}

export interface ImportEdge {
  fromFileKey: string;
  toFileKey: string;
}

/**
 * Counts of what we could NOT resolve.
 *
 * Reported, never swallowed (docs/ENGINEERING-RULES.md rule 2). A stated
 * resolution rate is a credibility builder; a silent one is a lie by omission.
 */
export interface ExtractionStats {
  filesScanned: number;
  callSitesTotal: number;
  callSitesResolvedInRepo: number;
  callSitesExternal: number;
  callSitesUnresolved: number;
  /**
   * `obj.method()` calls we deliberately do not resolve.
   *
   * Only TypeScript's type checker knows what `obj` is, and asking it costs
   * ~2.45ms a call — about forty seconds on a real repository — to recover the
   * 2.5% of edges these represent. Matching by method name instead would invent
   * structure, so they are counted and reported (rules 1 and 2).
   */
  callSitesNeedingTypes: number;
  /** Type mentions the compiler resolved to a type declared in this repo. */
  typeRefsResolved: number;
  /**
   * Type mentions that did not land on a type declared in this repo.
   *
   * Mostly library types — React, Prisma, node built-ins — which are not misses,
   * just not ours. Reported together because telling the two apart cheaply is not
   * possible here, and overstating success would be worse than overstating
   * failure (rule 2).
   */
  typeRefsUnresolved: number;
  /**
   * Edges discarded because an endpoint node was not emitted.
   *
   * Should be zero. A non-zero count means the extractor found a relationship it
   * could not anchor to both ends — reported rather than swallowed, because
   * HydraDB rejects the entire write when an endpoint is missing.
   */
  edgesDropped: number;
  /**
   * Declarations that wanted a key another declaration in the same file already
   * held — a static and an instance method of one name, or a getter and its
   * setter. The first wins; this is how many lost, so the number is visible
   * rather than inferred from a missing node (rule 2).
   */
  duplicateNames: number;
  /** Wall-clock milliseconds for the whole extraction. */
  durationMs: number;
}

/**
 * What each file declares, imports and exports.
 *
 * Returned so an incremental run can replay them for files it does not re-read —
 * resolution is a cross-file question, and without them parsing one file in
 * isolation resolves nothing it imports. See extract/incremental.ts.
 */
export type SymbolTables = Map<string, import('./symbols.js').FileSymbols>;

/** Everything one analysis run produces. */
export interface GraphFacts {
  repoRoot: string;
  files: FileFact[];
  functions: FunctionFact[];
  routes: RouteFact[];
  models: ModelFact[];
  fields: FieldFact[];
  types: TypeFact[];
  calls: CallEdge[];
  references: ReferenceEdge[];
  touches: TouchEdge[];
  imports: ImportEdge[];
  /**
   * Per-file symbol tables. Present on a fresh analysis, absent once facts have
   * been through JSON — Maps do not survive serialisation, and the incremental
   * cache stores them separately in a form that does.
   */
  symbols?: SymbolTables;
  stats: ExtractionStats;
}

/** HTTP methods Next.js App Router treats as route handlers. */
export const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Prisma operations that write. Used to weight a touch edge. */
export const PRISMA_WRITE_OPS = new Set([
  'create', 'createMany', 'update', 'updateMany', 'upsert',
  'delete', 'deleteMany', 'executeRaw', 'executeRawUnsafe',
]);

/** Prisma client operations we recognise as touching a model. */
export const PRISMA_OPS = new Set([
  ...PRISMA_WRITE_OPS,
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow',
  'findMany', 'count', 'aggregate', 'groupBy',
]);
