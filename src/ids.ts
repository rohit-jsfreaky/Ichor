/**
 * Stable string -> integer node ids.
 *
 * HydraDB requires node ids to be **non-negative integers**, and property values
 * may only be integers, floats, booleans or strings. So every real-world key we
 * have — a file path, a function signature, a Prisma model name — has to become
 * an integer, with the readable form kept alongside as a property.
 *
 * Two properties are load-bearing and must never change:
 *
 *  1. STABLE ACROSS RUNS. Diff mode compares the graph of commit A against the
 *     graph of commit B. If ids moved between runs, every node would look new
 *     and the diff would be meaningless. So: no counters, no randomness, no
 *     insertion order. A pure function of the key, forever.
 *
 *  2. COLLISION-CHECKED. Two different keys landing on one id would silently
 *     merge two functions into one, inventing call edges that do not exist —
 *     which breaks the one rule Ichor cannot break (see docs/ENGINEERING-RULES.md
 *     rule 1). We cannot make collisions impossible, so we detect them and throw.
 *
 * Algorithm: FNV-1a 64-bit, folded into 52 bits so the result is exactly
 * representable as a JavaScript number (Number.MAX_SAFE_INTEGER is 2^53 - 1).
 * Chosen for being tiny, dependency-free and well understood rather than fast.
 *
 * Collision math, so the 52-bit choice is defensible rather than vibes: with
 * n = 200,000 nodes the birthday estimate is n^2 / (2 * 2^52) ~= 4.4e-9. The
 * registry below turns that residual risk into a loud error, not a wrong graph.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** Keep 52 bits: the largest width that is always exact in a JS number. */
const ID_BITS = 52n;
const ID_MASK = (1n << ID_BITS) - 1n;

/**
 * Hash a key to a non-negative integer id.
 *
 * Pure and stable. Prefer {@link IdRegistry.idFor} in application code so that
 * collisions are detected; use this directly only where no registry exists.
 */
export function hashId(key: string): number {
  let hash = FNV_OFFSET_BASIS;

  // Hash the UTF-8 bytes, not UTF-16 code units, so the id does not depend on
  // how the runtime happens to represent the string.
  const bytes = new TextEncoder().encode(key);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }

  // Fold the high bits down instead of discarding them, so the top of the hash
  // still influences the result.
  const folded = (hash ^ (hash >> ID_BITS)) & ID_MASK;
  return Number(folded);
}

/** The kinds of node Ichor puts in the graph. Part of the key, so namespaces cannot clash. */
export type NodeKind = 'function' | 'route' | 'model' | 'field' | 'file' | 'type';

/**
 * A short, stable identifier for a checkout on this machine.
 *
 * Derived from the absolute path, so two clones of the same project in two
 * directories are two projects — which is right, because they are two working
 * copies a developer can edit independently.
 */
export function repoIdFor(repoRoot: string): string {
  const normalised = repoRoot.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return hashId(normalised).toString(36);
}

/** The repo an existing key belongs to. */
export function repoOf(key: string): string {
  const bar = key.indexOf('|');
  return bar === -1 ? '' : key.slice(0, bar);
}

/**
 * Build the canonical key for a node.
 *
 * The key is what makes an id meaningful, so its shape is part of the contract:
 * change it and every id changes, which invalidates every stored graph.
 *
 *   function  ->  <repo>|function:src/lib/invite.ts#sendInvite
 *   route     ->  <repo>|route:POST /api/invite
 *   model     ->  <repo>|model:User
 *   field     ->  <repo>|field:User.email
 *   file      ->  <repo>|file:src/lib/invite.ts
 *
 * The repo prefix is what makes more than one project able to share a database.
 * Without it, paths are repo-RELATIVE, so any two projects containing a
 * `src/lib/db.ts` produce a byte-identical key and therefore the same id — and
 * `model:User` collides across any two projects at all. The two would silently
 * merge into one node, inventing call edges between codebases that have never
 * heard of each other, which is the one thing this file exists to prevent.
 *
 * `path` must already be repo-relative and POSIX-separated — see {@link normalisePath}.
 */
export function nodeKey(repoId: string, kind: NodeKind, ...parts: string[]): string {
  return `${repoId}|${kind}:${parts.join('#')}`;
}

/**
 * Normalise a file path for use in a key.
 *
 * Windows separators and absolute paths would make ids machine-dependent, which
 * breaks stability rule 1 the moment the repo is analysed on another machine.
 */
export function normalisePath(filePath: string, repoRoot: string): string {
  const abs = filePath.replace(/\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const rel = abs.startsWith(root) ? abs.slice(root.length) : abs;
  return rel.replace(/^\//, '');
}

export class IdCollisionError extends Error {
  constructor(
    readonly id: number,
    readonly existingKey: string,
    readonly newKey: string,
  ) {
    super(
      `Node id collision on ${id}:\n` +
        `  existing: ${existingKey}\n` +
        `  new:      ${newKey}\n` +
        `Two distinct nodes would merge, inventing edges that do not exist. ` +
        `Widen ID_BITS in src/ids.ts or disambiguate the key.`,
    );
    this.name = 'IdCollisionError';
  }
}

/**
 * Assigns ids and refuses to let two different keys share one.
 *
 * Also holds the id -> key map, which is what lets a result set be turned back
 * into readable file/function names when we report a path.
 */
export class IdRegistry {
  private readonly keyById = new Map<number, string>();

  idFor(key: string): number {
    const id = hashId(key);
    const existing = this.keyById.get(id);

    if (existing === undefined) {
      this.keyById.set(id, key);
      return id;
    }
    if (existing !== key) {
      throw new IdCollisionError(id, existing, key);
    }
    return id;
  }

  /** Readable key for an id, or undefined if this registry never issued it. */
  keyFor(id: number): string | undefined {
    return this.keyById.get(id);
  }

  get size(): number {
    return this.keyById.size;
  }
}
