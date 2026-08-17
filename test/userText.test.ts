/**
 * Anchoring on what the code SAYS, not only what it is called.
 *
 * Bug 11: *"The expired-link message shown to viewers says 'Link has expired.' —
 * make it friendlier"*. Both copies of that string live in a function called `POST`
 * in a file called `route.ts`, so nothing in a name or a path points at them. Ichor
 * drew a 393-function boundary that reached neither, then challenged both when the
 * agent correctly edited them.
 *
 * Two signals fix it and they are different strengths:
 *
 *   the code says the task's WORDS      supporting evidence, weighted under a name
 *   the code says the task's QUOTED     the developer pointing at the code with a
 *   PHRASE, verbatim                    string instead of an identifier
 */

import { describe, expect, it } from 'vitest';

import { analyzeRepo } from '../src/extract/analyze.js';
import { findAnchors, quotedPhrases } from '../src/scope/anchors.js';

describe('phrases the prompt quotes', () => {
  it('reads a quoted message out of a prompt', () => {
    expect(
      quotedPhrases(`the message says 'Link has expired.' — make it friendlier`),
    ).toContain('link has expired.');
  });

  it('reads typographic quotes, which is what a chat box produces', () => {
    expect(quotedPhrases('it says “Link has expired.” right now')).toContain('link has expired.');
    expect(quotedPhrases('it says ‘please try again’ instead')).toContain('please try again');
  });

  it('reads backticks', () => {
    expect(quotedPhrases('change `Link has expired` to something kinder')).toContain(
      'link has expired',
    );
  });

  it('ignores a single quoted word, which is an identifier not a message', () => {
    // `cn` and `POST` are handled by name matching; treating them as phrases would
    // make every backticked symbol a phrase match.
    expect(quotedPhrases('extract the `cn` helper')).toEqual([]);
    expect(quotedPhrases('rename `createVendor` please')).toEqual([]);
  });

  it('ignores a prompt with no quotes at all', () => {
    expect(quotedPhrases('make the expired link message friendlier')).toEqual([]);
  });
});

describe('user-facing text in the demo', () => {
  const facts = analyzeRepo('./demo');

  it('captures the copy a function writes', () => {
    const withText = facts.functions.filter((f) => f.text?.length);
    expect(withText.length).toBeGreaterThan(0);
    // Every kept string should look like something a person reads.
    for (const fn of withText) {
      for (const line of fn.text!) {
        expect(line).toMatch(/\s/);
        expect(line.length).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('does not keep module specifiers, class lists or identifiers', () => {
    for (const fn of facts.functions) {
      for (const line of fn.text ?? []) {
        expect(line).not.toMatch(/^@?[./]/); // './x', '@/lib/y'
        expect(line).not.toMatch(/[{}<>|=_$]/); // templates, selectors, snake_case
      }
    }
  });

  it('bounds what it keeps per function', () => {
    for (const fn of facts.functions) {
      expect(fn.text?.length ?? 0).toBeLessThanOrEqual(8);
      for (const line of fn.text ?? []) expect(line.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('a task named only by its copy', () => {
  const facts = analyzeRepo('./demo');

  /** A message the demo actually shows, found rather than assumed. */
  const someCopy = facts.functions.flatMap((f) => f.text ?? [])[0];

  it('the demo has copy to test against', () => {
    expect(someCopy).toBeTruthy();
  });

  it('quoting it anchors the function that says it', () => {
    const { anchors } = findAnchors(facts, `change the message that says '${someCopy}'`);
    const bySaying = anchors.filter((a) => /says the exact words/.test(a.why));
    expect(bySaying.length).toBeGreaterThan(0);
  });

  it('explains itself in terms a developer can check', () => {
    const { anchors } = findAnchors(facts, `change the message that says '${someCopy}'`);
    const hit = anchors.find((a) => /says the exact words/.test(a.why));
    expect(hit?.why).toContain('says the exact words the task quoted');
  });

  it('a prompt naming nothing in the repo still anchors nothing', () => {
    // The new signal must not make every prompt match something.
    const { anchors } = findAnchors(facts, 'update the kubernetes ingress annotations');
    expect(anchors.length).toBe(0);
  });
});
