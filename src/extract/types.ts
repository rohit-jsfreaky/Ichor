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
  calls: CallEdge[];
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
