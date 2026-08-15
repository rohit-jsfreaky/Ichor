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
  name: string;
  exported: boolean;
  /** True for React components — capitalised and returning JSX. */
  isComponent: boolean;
  /** True when declared in a *.test.ts / *.spec.ts file. */
  isTest: boolean;
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
  /** Wall-clock milliseconds for the whole extraction. */
  durationMs: number;
}

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
