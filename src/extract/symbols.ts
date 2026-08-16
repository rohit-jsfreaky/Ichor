/**
 * Working out which function a name refers to, without the type checker.
 *
 * This is the reason Ichor reads a 200,000-line codebase in seconds instead of
 * a minute. Asking TypeScript's checker "which function is this?" costs about
 * 2.45ms per call site, and a real repository has 33,000 of them — roughly
 * forty seconds. Measured against what that buys: of the calls that actually
 * become an edge in our graph, 96.5% are a plain `send(x)`, 1% are `this.foo()`,
 * and only 2.5% are `obj.method()` on a value whose type only the checker knows.
 *
 * Forty seconds for 2.5% is a bad trade, and the other 97.5% needs no inference
 * at all — just bookkeeping. `import { send } from './email'` plus the list of
 * what `./email` exports IS the answer, and both are plain syntax.
 *
 * So this module keeps three tables per file — what it declares, what it imports,
 * what it exports — and answers by lookup. Nothing here guesses: a name either
 * resolves to a declaration we can point at, or it is reported unresolved
 * (ENGINEERING-RULES rules 1 and 2).
 */

import * as path from 'node:path';

/** Where a locally-bound name came from. */
export interface ImportBinding {
  /** The specifier exactly as written, e.g. `./email` or `react`. */
  module: string;
  /** The name inside that module. `default` and `*` are the special cases. */
  imported: string;
}

/** How an exported name is satisfied. */
export interface ExportBinding {
  /** Declared in this file under this name. */
  local?: string;
  /** Re-exported: `export { x } from './y'`. */
  fromModule?: string;
  imported?: string;
}

export interface FileSymbols {
  /** Repo-relative path. */
  file: string;
  /** Every top-level declaration: name -> node key. */
  locals: Map<string, string>;
  /** Local name -> where it was imported from. */
  imports: Map<string, ImportBinding>;
  /** Exported name -> how it is satisfied. */
  exports: Map<string, ExportBinding>;
  /** `export * from './y'` — searched only when a name is not found directly. */
  starExports: string[];
}

export type Resolution =
  | { kind: 'repo'; key: string }
  | { kind: 'external' }
  | { kind: 'unresolved' };

const EXTERNAL: Resolution = { kind: 'external' };
const UNRESOLVED: Resolution = { kind: 'unresolved' };

/** A tsconfig `paths` entry, pre-split around its wildcard. */
export interface PathAlias {
  prefix: string;
  suffix: string;
  targets: { prefix: string; suffix: string }[];
}

/**
 * Turn tsconfig `paths` into something cheap to match.
 *
 * `{"@/*": ["./src/*"]}` is by far the most common shape, and without it every
 * `@/lib/db` import in a Next.js app is unresolvable — which is most of them.
 */
export function parseAliases(paths: Record<string, string[]> | undefined, baseUrl: string): PathAlias[] {
  if (!paths) return [];
  const split = (pattern: string) => {
    const star = pattern.indexOf('*');
    return star === -1
      ? { prefix: pattern, suffix: '' }
      : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1) };
  };

  return Object.entries(paths).map(([pattern, targets]) => ({
    ...split(pattern),
    targets: targets.map((t) => {
      const parts = split(t);
      return {
        prefix: path.posix.join(baseUrl, parts.prefix),
        suffix: parts.suffix,
      };
    }),
  }));
}

export interface ResolverStats {
  /** Names answered from the tables. */
  resolved: number;
  /** Names that lead outside the repository. */
  external: number;
  /** Names we could not place. Counted, never guessed. */
  unresolved: number;
}

export interface Resolver {
  /** What does `name` refer to, as written inside `fromFile`? */
  resolve(fromFile: string, name: string): Resolution;
  /** What does `ns.name` refer to, when `ns` is `import * as ns from '…'`? */
  resolveNamespaceMember(fromFile: string, namespaceName: string, member: string): Resolution;
  /** Is this local name a namespace import? */
  namespaceModule(fromFile: string, name: string): string | undefined;
  /** Which repo file does this specifier point at, if any? */
  resolveModuleFrom(fromFile: string, specifier: string): string | 'external' | undefined;
  /** What does `Class.member` refer to, when `Class` is visible from `fromFile`? */
  resolveMember(fromFile: string, className: string, member: string): Resolution;
  symbolsFor(file: string): FileSymbols | undefined;
  stats: ResolverStats;
}

/**
 * Build the resolver over a repo's symbol tables.
 *
 * `files` is the set of repo-relative paths that exist, which is what makes
 * module resolution a set lookup rather than a filesystem probe.
 */
export function createResolver(
  tables: Map<string, FileSymbols>,
  files: Set<string>,
  aliases: PathAlias[],
): Resolver {
  const stats: ResolverStats = { resolved: 0, external: 0, unresolved: 0 };

  // Module specifiers repeat constantly — every file in a folder imports the
  // same handful — so resolving one twice is pure waste.
  const moduleCache = new Map<string, string | 'external' | undefined>();
  const exportCache = new Map<string, Resolution>();

  /** Probe the extensions TypeScript would, in the order it would. */
  const probe = (base: string): string | undefined => {
    if (files.has(base)) return base;
    // `./x.js` in ESM source usually means `./x.ts` on disk.
    const withoutJs = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const candidate of [
      `${base}.ts`, `${base}.tsx`,
      `${withoutJs}.ts`, `${withoutJs}.tsx`,
      `${base}/index.ts`, `${base}/index.tsx`,
    ]) {
      if (files.has(candidate)) return candidate;
    }
    return undefined;
  };

  const resolveModule = (fromFile: string, specifier: string): string | 'external' | undefined => {
    const cacheKey = `${fromFile} ${specifier}`;
    const cached = moduleCache.get(cacheKey);
    if (cached !== undefined || moduleCache.has(cacheKey)) return cached;

    let result: string | 'external' | undefined;

    if (specifier.startsWith('.')) {
      const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
      result = probe(joined) ?? 'external';
    } else {
      // A bare specifier is a package unless a tsconfig alias claims it.
      result = 'external';
      for (const alias of aliases) {
        if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) continue;
        const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
        for (const target of alias.targets) {
          const hit = probe(path.posix.normalize(`${target.prefix}${middle}${target.suffix}`));
          if (hit) { result = hit; break; }
        }
        if (result !== 'external') break;
      }
    }

    moduleCache.set(cacheKey, result);
    return result;
  };

  /**
   * What does `file` export under `name`?
   *
   * `seen` guards the cycles that barrel files create — `a` re-exports `b` which
   * re-exports `a` is common enough that without it this recurses forever.
   */
  const walkExport = (file: string, name: string, seen: Set<string>): Resolution => {
    const guard = `${file} ${name}`;
    if (seen.has(guard)) return UNRESOLVED;
    seen.add(guard);

    const symbols = tables.get(file);
    if (!symbols) return UNRESOLVED;

    let result: Resolution = UNRESOLVED;
    const binding = symbols.exports.get(name);

    if (binding?.local) {
      const key = symbols.locals.get(binding.local);
      if (key) result = { kind: 'repo', key };
    } else if (binding?.fromModule) {
      const target = resolveModule(file, binding.fromModule);
      if (target === 'external') result = EXTERNAL;
      else if (target) result = walkExport(target, binding.imported ?? name, seen);
    } else {
      // Not named directly — walk the `export *` chain.
      for (const specifier of symbols.starExports) {
        const target = resolveModule(file, specifier);
        if (target === 'external') { result = EXTERNAL; continue; }
        if (!target) continue;
        const found = walkExport(target, name, seen);
        if (found.kind === 'repo') { result = found; break; }
      }
    }

    return result;
  };

  /**
   * Cache every answer, including the failures.
   *
   * Only successes were cached, so every MISS re-walked the entire `export *`
   * chain from scratch — and misses are the common case, because most names a
   * file mentions are not exported by the module it imported them from. On a
   * 1,362-file repository that repeated walk cost more than parsing the whole
   * codebase.
   *
   * Caching only at this outer level is deliberate: a result produced deeper in
   * a recursion may have been cut short by the cycle guard, and storing that
   * would poison the table with a false "unresolved".
   */
  const lookupExport = (file: string, name: string): Resolution => {
    const cacheKey = `${file} ${name}`;
    const cached = exportCache.get(cacheKey);
    if (cached) return cached;

    const result = walkExport(file, name, new Set());
    exportCache.set(cacheKey, result);
    return result;
  };

  const resolve = (fromFile: string, name: string): Resolution => {
    const symbols = tables.get(fromFile);
    if (!symbols) { stats.unresolved++; return UNRESOLVED; }

    // Declared right here — the common case, and free.
    const local = symbols.locals.get(name);
    if (local) { stats.resolved++; return { kind: 'repo', key: local }; }

    const binding = symbols.imports.get(name);
    if (!binding) { stats.unresolved++; return UNRESOLVED; }

    const target = resolveModule(fromFile, binding.module);
    if (target === 'external') { stats.external++; return EXTERNAL; }
    if (!target) { stats.unresolved++; return UNRESOLVED; }

    const found = lookupExport(target, binding.imported);
    if (found.kind === 'repo') stats.resolved++;
    else if (found.kind === 'external') stats.external++;
    else stats.unresolved++;
    return found;
  };

  /**
   * Two steps, because a method lives with its class, not with the caller.
   *
   * `const c = new GraphClient(); c.close()` is written in one file and answered
   * in another: resolve `GraphClient` through the import map to find where it is
   * declared, then look for `GraphClient.close` THERE. Looking the method up in
   * the calling file — the obvious first attempt — finds nothing, and quietly
   * dropped every cross-file method call in the repository.
   */
  const resolveMember = (fromFile: string, className: string, member: string): Resolution => {
    const owner = resolve(fromFile, className);
    if (owner.kind !== 'repo') return owner;

    // Keys are `<kind>:<file>#<name>`.
    const hash = owner.key.lastIndexOf('#');
    const colon = owner.key.indexOf(':');
    if (hash === -1 || colon === -1) return UNRESOLVED;

    const ownerFile = owner.key.slice(colon + 1, hash);
    const key = tables.get(ownerFile)?.locals.get(`${className}.${member}`);
    if (!key) { stats.unresolved++; return UNRESOLVED; }

    stats.resolved++;
    return { kind: 'repo', key };
  };

  return {
    resolve,
    resolveMember,
    resolveModuleFrom: resolveModule,
    namespaceModule: (fromFile, name) => {
      const binding = tables.get(fromFile)?.imports.get(name);
      return binding?.imported === '*' ? binding.module : undefined;
    },
    resolveNamespaceMember: (fromFile, namespaceName, member) => {
      const specifier = tables.get(fromFile)?.imports.get(namespaceName);
      if (!specifier || specifier.imported !== '*') { stats.unresolved++; return UNRESOLVED; }

      const target = resolveModule(fromFile, specifier.module);
      if (target === 'external') { stats.external++; return EXTERNAL; }
      if (!target) { stats.unresolved++; return UNRESOLVED; }

      const found = lookupExport(target, member);
      if (found.kind === 'repo') stats.resolved++;
      else if (found.kind === 'external') stats.external++;
      else stats.unresolved++;
      return found;
    },
    symbolsFor: (file) => tables.get(file),
    stats,
  };
}
