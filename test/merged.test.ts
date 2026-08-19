/**
 * Declaration merging produces ONE node, not one per declaration.
 *
 * This exists because of a total failure, not a cosmetic one. `interface X {}`
 * declared twice in a file is a single type in TypeScript, and emitting a node
 * per declaration put two rows with the same id and different `line` values into
 * one write. HydraDB rejects the entire statement for that:
 *
 *   conflicting metadata values for vertex 2802411236362412 property line
 *
 * The build dies, no facts are written, and the repository cannot be indexed at
 * all — from one merged interface out of 8,098 distinct ids on a real project.
 *
 * The invariant this file defends is simple and worth stating plainly: **no two
 * facts of the same kind may share a key.** Everything else here is detail.
 *
 * Needs no Docker — extraction is pure.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { analyzeRepo } from '../src/extract/analyze.js';
import type { GraphFacts } from '../src/extract/types.js';

const FIXTURES = path.resolve(process.cwd(), 'test/fixtures');

let facts: GraphFacts;

beforeAll(() => {
  facts = analyzeRepo(FIXTURES);
}, 120_000);

const typesNamed = (name: string) => facts.types.filter((t) => t.name === name);

describe('the key invariant', () => {
  /**
   * The assertion that would have caught this before it ever reached a user.
   *
   * Deliberately over every node collection rather than only types: the failure
   * is a property of duplicate keys, not of interfaces, so the guard belongs at
   * the level the failure lives at.
   */
  it('never emits two facts of one kind with the same key', () => {
    const collections: [string, { key: string }[]][] = [
      ['files', facts.files],
      ['functions', facts.functions],
      ['types', facts.types],
      ['routes', facts.routes],
      ['models', facts.models],
      ['fields', facts.fields],
    ];

    for (const [label, rows] of collections) {
      const seen = new Map<string, number>();
      for (const row of rows) seen.set(row.key, (seen.get(row.key) ?? 0) + 1);
      const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
      expect(duplicated, `${label} has duplicate keys: ${JSON.stringify(duplicated)}`).toEqual([]);
    }
  });
});

describe('merged interfaces', () => {
  it('collapses two declarations into one type', () => {
    expect(typesNamed('MergedOptions')).toHaveLength(1);
  });

  it('reports the type at its first declaration', () => {
    const merged = typesNamed('MergedOptions')[0]!;
    const late = typesNamed('LateExport')[0]!;
    // The first declaration of each appears above the second in the fixture.
    expect(merged.line).toBeLessThan(late.line);
    expect(merged.kind).toBe('interface');
  });

  it('is exported when ANY declaration exports it', () => {
    // `LateExport` is declared unexported first, then exported. The type is on
    // the public surface, and treating the first declaration as the whole truth
    // would hide it.
    expect(typesNamed('LateExport')).toHaveLength(1);
    expect(typesNamed('LateExport')[0]!.exported).toBe(true);
  });

  it('counts the fold rather than swallowing it', () => {
    // Two merges in the fixture: MergedOptions and LateExport.
    expect(facts.stats.mergedDeclarations).toBeGreaterThanOrEqual(2);
  });

  it('still resolves references into the merged type', () => {
    // Attribution must survive the merge — a function annotated with the merged
    // type still reaches it, which is what the per-declaration spans preserve.
    const merged = typesNamed('MergedOptions')[0]!;
    const user = facts.functions.find((f) => f.name === 'usesMerged');
    expect(user).toBeDefined();
    expect(
      facts.references.some((r) => r.fromKey === user!.key && r.toKey === merged.key),
    ).toBe(true);
  });
});
