/**
 * Tests for src/ids.ts.
 *
 * This module is load-bearing in a way most code is not: ids are baked into every
 * stored graph, and diff mode compares graphs across runs and machines. If ids
 * are unstable, diff mode silently reports everything as new. If two keys collide,
 * two functions merge into one and we invent call edges — breaking the one rule
 * Ichor cannot break.
 *
 * So these tests are about *properties*, not coverage.
 */

import { describe, it, expect } from 'vitest';
import { hashId, nodeKey, normalisePath, IdRegistry, IdCollisionError } from '../src/ids.js';

describe('hashId', () => {
  it('is deterministic', () => {
    expect(hashId('function:src/a.ts#foo')).toBe(hashId('function:src/a.ts#foo'));
  });

  it('is a non-negative safe integer (HydraDB requires this)', () => {
    for (const key of ['a', '', 'function:src/very/long/path.ts#someName', '🙂 unicode', 'x'.repeat(5000)]) {
      const id = hashId(key);
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(0);
    }
  });

  it('separates keys that differ only slightly', () => {
    expect(hashId('function:src/a.ts#foo')).not.toBe(hashId('function:src/a.ts#foO'));
    expect(hashId('function:src/a.ts#foo')).not.toBe(hashId('function:src/b.ts#foo'));
  });

  it('does not collide across a realistic corpus', () => {
    // Roughly the shape and size of a large monorepo's function set.
    const seen = new Map<number, string>();
    for (let f = 0; f < 400; f++) {
      for (let n = 0; n < 250; n++) {
        const key = nodeKey('function', `src/module${f}/file${f}.ts`, `handler${n}`);
        const id = hashId(key);
        const prev = seen.get(id);
        if (prev !== undefined && prev !== key) throw new Error(`collision: ${prev} vs ${key}`);
        seen.set(id, key);
      }
    }
    expect(seen.size).toBe(100_000);
  });
});

describe('nodeKey', () => {
  it('keeps kinds in separate namespaces', () => {
    // A model named "User" and a function named "User" must never share an id.
    expect(hashId(nodeKey('model', 'User'))).not.toBe(hashId(nodeKey('function', 'User')));
  });

  it('builds the documented shapes', () => {
    expect(nodeKey('function', 'src/lib/invite.ts', 'sendInvite')).toBe('function:src/lib/invite.ts#sendInvite');
    expect(nodeKey('route', 'POST /api/invite')).toBe('route:POST /api/invite');
    expect(nodeKey('field', 'User.email')).toBe('field:User.email');
  });
});

describe('normalisePath', () => {
  it('makes ids machine-independent', () => {
    // The same file analysed on Windows and on CI must produce the same id,
    // otherwise a graph built on one machine cannot be diffed against another.
    const win = normalisePath('D:\\repos\\app\\src\\lib\\invite.ts', 'D:\\repos\\app');
    const nix = normalisePath('/home/rohit/app/src/lib/invite.ts', '/home/rohit/app');
    expect(win).toBe('src/lib/invite.ts');
    expect(nix).toBe('src/lib/invite.ts');
    expect(hashId(nodeKey('function', win, 'x'))).toBe(hashId(nodeKey('function', nix, 'x')));
  });

  it('tolerates a trailing separator on the root', () => {
    expect(normalisePath('/app/src/a.ts', '/app/')).toBe('src/a.ts');
  });
});

describe('IdRegistry', () => {
  it('returns a stable id for the same key', () => {
    const reg = new IdRegistry();
    const key = nodeKey('function', 'src/a.ts', 'foo');
    expect(reg.idFor(key)).toBe(reg.idFor(key));
    expect(reg.size).toBe(1);
  });

  it('maps an id back to a readable key', () => {
    const reg = new IdRegistry();
    const key = nodeKey('route', 'POST /api/invite');
    expect(reg.keyFor(reg.idFor(key))).toBe(key);
  });

  it('throws loudly on a genuine collision rather than merging nodes', () => {
    // Force the failure that must never pass silently.
    const reg = new IdRegistry();
    const id = reg.idFor('function:src/a.ts#foo');
    // @ts-expect-error reaching into private state to simulate a hash collision
    reg.keyById.set(id, 'function:src/DIFFERENT.ts#bar');
    expect(() => reg.idFor('function:src/a.ts#foo')).toThrow(IdCollisionError);
  });
});
