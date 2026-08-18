/**
 * Speaking to Codex in the shape Codex accepts.
 *
 * Ichor emitted the per-turn briefing as plain text on stdout, which is what
 * Claude Code wants. Codex wants JSON, and answers plain text with:
 *
 *   UserPromptSubmit hook (failed)
 *   error: hook returned invalid user prompt submit JSON output
 *
 * That was observed in a live Codex session, and the consequence is larger than
 * one error line. The briefing carries the scope, the file list AND the only
 * mention Ichor ever makes of its retrieval commands. Losing it silently is why
 * Codex reached straight for `rg`: nothing had told it there was anything else.
 *
 * A near-silent, host-specific serialisation failure is exactly the kind of bug
 * that survives every test written against the other host, so these pin the
 * contract for both.
 */

import { describe, expect, it } from 'vitest';

import { agentOf, contextPayload } from '../src/hook/prompt.js';

describe('telling the two hosts apart', () => {
  it('reads Codex from turn_id and Claude Code from prompt_id', () => {
    // The same discriminator readPromptId already uses. One answer to "who am I
    // talking to", so the two cannot drift apart.
    expect(agentOf({ turn_id: 't-1' } as never)).toBe('codex');
    expect(agentOf({ prompt_id: 'p-1' } as never)).toBe('claude-code');
  });

  it('assumes Claude Code when neither field is present', () => {
    // Failing towards the host that accepts plain text: a wrong guess there is a
    // briefing that reads oddly, not one that is rejected outright.
    expect(agentOf({} as never)).toBe('claude-code');
  });
});

describe('the briefing on the wire', () => {
  it('is valid JSON for Codex, carrying the text intact', () => {
    const briefing = '[ichor] Files in scope: 3';
    const written = contextPayload(briefing, 'codex');

    // The whole bug: Codex rejects anything it cannot parse.
    const parsed = JSON.parse(written);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toBe(briefing);
  });

  it('stays plain text for Claude Code', () => {
    const written = contextPayload('[ichor] Files in scope: 3', 'claude-code');

    expect(written.trim()).toBe('[ichor] Files in scope: 3');
    expect(() => JSON.parse(written)).toThrow();
  });

  it('survives a briefing containing quotes and newlines', () => {
    // The real briefing quotes the task, which is arbitrary user text.
    const nasty = 'Job in progress: "fix the \\"quoted\\" thing"\nFiles in scope: 2';
    const parsed = JSON.parse(contextPayload(nasty, 'codex'));

    expect(parsed.hookSpecificOutput.additionalContext).toBe(nasty);
  });

  it('writes nothing at all when there is no briefing', () => {
    // An empty JSON envelope is still a thing to parse and a thing to render.
    expect(contextPayload('', 'codex')).toBe('');
    expect(contextPayload('   ', 'claude-code')).toBe('');
  });
});
