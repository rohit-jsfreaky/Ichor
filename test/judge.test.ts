/**
 * Judge tests that need no API key.
 *
 * The parts worth testing are the ones that protect us from the model: parsing
 * is strict, a malformed answer is discarded rather than guessed at, and the
 * prompt actually carries the evidence the Judge is supposed to reason over.
 *
 * Whether the model reasons *well* is checked separately by scripts/judge-test.ts,
 * which needs a key and real credit.
 */

import { describe, it, expect } from 'vitest';
import { parseOpinion, buildPrompt, formatOpinion } from '../src/judge/judge.js';
import type { Neighborhood } from '../src/scope/neighborhood.js';
import type { Verdict } from '../src/scope/classify.js';

function neighborhood(): Neighborhood {
  return {
    task: 'Fix duplicate email handling in vendor onboarding',
    terms: ['duplicate', 'email', 'vendor'],
    anchors: [],
    members: new Map([
      [1, { id: 1, name: 'createVendor', file: 'src/lib/vendors/create.ts', distance: 0, reason: 'anchor' }],
      [2, { id: 2, name: 'POST', file: 'src/app/api/vendors/route.ts', distance: 0, reason: 'handles POST /api/vendors' }],
    ]),
    models: new Map([[1, { name: 'Vendor', viaFunction: 'createVendor' }]]),
    coreModels: new Set(['Vendor']),
    stats: { anchorCount: 2, memberCount: 2, maxDistance: 0, queryCount: 0, truncated: false, durationMs: 0 },
  };
}

function verdict(): Verdict {
  return {
    decision: 'SUSPICIOUS',
    reason: 'introduces a new POST endpoint that reaches Vendor',
    evidence: [{ kind: 'existing-flow', text: 'POST /api/vendors → createVendor → Vendor' }],
    question: 'Why is a separate endpoint required?',
    needsJudge: true,
  };
}

describe('parseOpinion', () => {
  const good = JSON.stringify({
    decision: 'SUSPICIOUS_EXPANSION',
    confidence: 'high',
    taskRequirement: 'handle the duplicate error on the existing submit path',
    agentClaim: 'earlier validation improves UX',
    supporting: [],
    contradicting: ['the existing path already reaches the uniqueness check'],
    recommendation: 'handle it in the existing handler',
  });

  it('parses a well-formed answer', () => {
    const opinion = parseOpinion(good, 'test-model');
    expect(opinion?.decision).toBe('SUSPICIOUS_EXPANSION');
    expect(opinion?.confidence).toBe('high');
    expect(opinion?.contradicting).toHaveLength(1);
    expect(opinion?.model).toBe('test-model');
  });

  it('survives a model wrapping JSON in a fence', () => {
    expect(parseOpinion('```json\n' + good + '\n```', 'm')?.decision).toBe('SUSPICIOUS_EXPANSION');
  });

  it('survives prose around the JSON', () => {
    expect(parseOpinion(`Sure! Here is my answer:\n${good}\nHope that helps.`, 'm')?.decision).toBe(
      'SUSPICIOUS_EXPANSION',
    );
  });

  it('rejects an unknown decision rather than guessing', () => {
    // A verdict we do not recognise must not be coerced into one we do — that
    // would be inventing authority the model never expressed.
    expect(parseOpinion(JSON.stringify({ decision: 'PROBABLY_FINE' }), 'm')).toBeUndefined();
  });

  it('rejects unparseable output', () => {
    expect(parseOpinion('the model rambled and produced no json', 'm')).toBeUndefined();
    expect(parseOpinion('{ not valid json', 'm')).toBeUndefined();
    expect(parseOpinion('', 'm')).toBeUndefined();
  });

  it('defaults an unrecognised confidence to low', () => {
    const opinion = parseOpinion(JSON.stringify({ decision: 'EXPECTED', confidence: 'certain' }), 'm');
    expect(opinion?.confidence).toBe('low');
  });
});

describe('buildPrompt', () => {
  it('carries the task, the data, the scope and the evidence', () => {
    const prompt = buildPrompt({
      neighborhood: neighborhood(),
      verdict: verdict(),
      file: 'src/app/api/vendors/check-email/route.ts',
      agentReason: 'Earlier validation improves UX.',
    });

    expect(prompt).toContain('Fix duplicate email handling');
    expect(prompt).toContain('Vendor');                                  // the data
    expect(prompt).toContain('createVendor');                            // what is in scope
    expect(prompt).toContain('POST /api/vendors → createVendor → Vendor'); // the existing path
    expect(prompt).toContain('check-email');                             // the proposed change
    expect(prompt).toContain('Earlier validation improves UX.');         // the claim
  });

  it('says plainly when nothing connects the change', () => {
    const prompt = buildPrompt({
      neighborhood: neighborhood(),
      verdict: { ...verdict(), evidence: [] },
      file: 'src/lib/billing/invoice.ts',
    });
    expect(prompt).toContain('nothing connects this change to the task');
    expect(prompt).toContain('(none given)');
  });
});

describe('formatOpinion', () => {
  it('leads with the decision and includes the counter-argument', () => {
    const text = formatOpinion({
      decision: 'SUSPICIOUS_EXPANSION',
      confidence: 'high',
      taskRequirement: 'handle the duplicate on the existing path',
      agentClaim: 'earlier validation improves UX',
      supporting: [],
      contradicting: ['the submit path already reaches the uniqueness check'],
      recommendation: 'keep the fix on the existing handler',
      model: 'test',
    });

    expect(text.startsWith('Ichor Judge: SUSPICIOUS_EXPANSION')).toBe(true);
    expect(text).toContain('already reaches the uniqueness check');
    expect(text).toContain('keep the fix on the existing handler');
  });
});
