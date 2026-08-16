/**
 * Can Ichor see every shape a function is written in?
 *
 * A function Ichor cannot see is worse than a boundary that is slightly wrong:
 * the agent can rewrite it and Ichor has nothing to say, because as far as the
 * graph is concerned the code does not exist. Measured on a real React product,
 * the three shapes originally covered were missing 1,206 functions — 35% of the
 * codebase — and 3,374 connections between them.
 *
 * Each assertion here corresponds to a shape that was invisible at some point.
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

const fn = (name: string) => facts.functions.find((f) => f.name === name);
const names = () => facts.functions.map((f) => f.name);

/** A CALLS edge between two functions, by name. */
const edge = (from: string, to: string) => {
  const source = fn(from);
  const target = fn(to);
  if (!source || !target) return undefined;
  return facts.calls.find((c) => c.fromKey === source.key && c.toKey === target.key);
};

describe('shapes that were once invisible', () => {
  it('finds plain declarations and arrow constants', () => {
    expect(fn('topLevel')).toBeDefined();
    expect(fn('arrow')).toBeDefined();
  });

  it('keeps one node for an overloaded function, not one per signature', () => {
    expect(names().filter((n) => n === 'overloaded')).toHaveLength(1);
    // The implementation carries the body; a signature would report the wrong line.
    expect(fn('overloaded')?.exported).toBe(true);
  });

  it('finds functions declared inside other functions, qualified by their parent', () => {
    expect(fn('outer.inner')).toBeDefined();
    expect(fn('outer.innerArrow')).toBeDefined();
    expect(fn('outer.innerArrow.deeper')).toBeDefined();
  });

  it('joins a parent to the functions declared inside it', () => {
    // Without this the graph is in pieces and boundaries come out too small.
    expect(edge('outer', 'outer.inner')?.viaContains).toBe(true);
    expect(edge('outer.innerArrow', 'outer.innerArrow.deeper')?.viaContains).toBe(true);
  });

  it('finds object-literal methods, both shorthand and arrow', () => {
    expect(fn('api.create')).toBeDefined();
    expect(fn('api.list')).toBeDefined();
    // A number is not a function.
    expect(fn('api.notAFunction')).toBeUndefined();
  });

  it('finds constructors, accessors and class property arrows', () => {
    expect(fn('Service.constructor')).toBeDefined();
    expect(fn('Service.name')).toBeDefined();
    expect(fn('Service.method')).toBeDefined();
    expect(fn('Service.handle')).toBeDefined();
  });

  it('does not claim a private method is reachable from outside', () => {
    expect(fn('Service.hidden')).toBeDefined();
    expect(fn('Service.hidden')?.exported).toBe(false);
    expect(fn('Service.method')?.exported).toBe(true);
  });

  it('sees through a wrapper call to the function inside it', () => {
    // `memo(() => …)`, `forwardRef(…)`, and every project's own HOC.
    expect(fn('Wrapped')).toBeDefined();
  });

  it('treats `new Service()` as a call to the constructor', () => {
    expect(edge('makesOne', 'Service.constructor')).toBeDefined();
  });

  it('records `extends` as a reference between types', () => {
    const service = facts.types.find((t) => t.name === 'Service');
    const base = facts.types.find((t) => t.name === 'Base');
    expect(service).toBeDefined();
    expect(base).toBeDefined();
    expect(
      facts.references.some((r) => r.fromKey === service!.key && r.toKey === base!.key),
    ).toBe(true);
  });

  it('finds an anonymous default export', () => {
    expect(fn('default')).toBeDefined();
  });

  it('anchors every edge it emits', () => {
    expect(facts.stats.edgesDropped).toBe(0);
  });
});
