/**
 * What `ichor init` writes into a repo.
 *
 * Every assertion here exists because the alternative fails SILENTLY. A hook
 * config that is merely misshapen does not error — the agent starts, edits the
 * whole repo, and Ichor never runs. That happened: Codex was given a PreToolUse
 * entry with `type`/`command` at the top level instead of inside a nested
 * `hooks` array, accepted the file without complaint, and policed nothing.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installHooks } from '../src/hook/install.js';

let repo: string;

const read = (file: string) => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ichor-install-'));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('the three events', () => {
  it('registers all of them for both agents', () => {
    installHooks(repo);

    for (const [label, file] of [
      ['claude', '.claude/settings.json'],
      ['codex', '.codex/hooks.json'],
    ] as const) {
      const hooks = read(file).hooks;
      // PreToolUse challenges. UserPromptSubmit notices the developer changing
      // job. Stop rebuilds the graph while nobody is waiting. Missing any one
      // fails silently — nothing errors, Ichor just stops keeping up.
      for (const event of ['PreToolUse', 'UserPromptSubmit', 'Stop']) {
        expect(hooks[event], `${label}: ${event}`).toBeDefined();
        expect(Array.isArray(hooks[event][0].hooks), `${label}: ${event} nested`).toBe(true);
        expect(hooks[event][0].hooks[0].command).toBe('ichor hook');
      }
    }
  });

  it('omits the matcher where neither host honours one', () => {
    installHooks(repo);
    const hooks = read('.claude/settings.json').hooks;

    expect(hooks.PreToolUse[0].matcher).toBeDefined();
    // Writing a matcher that is silently ignored invites someone to edit it and
    // wonder why nothing changes.
    expect(hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(hooks.Stop[0].matcher).toBeUndefined();
  });

  it('adds a newly supported event to an install that predates it', () => {
    // An older Ichor wrote only PreToolUse. Re-running init must add the rest
    // without duplicating what is already there.
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude/settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'ichor hook' }] }] },
      }),
      'utf8',
    );

    installHooks(repo);
    const hooks = read('.claude/settings.json').hooks;

    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
  });
});

describe('hook config shape', () => {
  it('gives BOTH agents the same nested hooks array', () => {
    installHooks(repo);

    const claude = read('.claude/settings.json').hooks.PreToolUse[0];
    const codex = read('.codex/hooks.json').hooks.PreToolUse[0];

    for (const [agent, entry] of [['claude', claude], ['codex', codex]] as const) {
      expect(Array.isArray(entry.hooks), `${agent}: PreToolUse entry needs a hooks array`).toBe(true);
      expect(entry.hooks[0].type, `${agent}: handler type`).toBe('command');
      expect(entry.hooks[0].command, `${agent}: handler command`).toBe('ichor hook');
      // The flattened shape is the bug: never hoist the handler onto the entry.
      expect(entry.type, `${agent}: must not flatten type onto the entry`).toBeUndefined();
      expect(entry.command, `${agent}: must not flatten command onto the entry`).toBeUndefined();
    }

    expect(codex.matcher).toBe(claude.matcher);
  });

  it('matches the edit tools both agents report', () => {
    installHooks(repo);
    const matcher = new RegExp(read('.codex/hooks.json').hooks.PreToolUse[0].matcher);

    for (const tool of ['Edit', 'Write', 'MultiEdit', 'apply_patch']) {
      expect(matcher.test(tool), `${tool} must match`).toBe(true);
    }
  });

  it('calls the binary directly, never through npx', () => {
    installHooks(repo);
    // `ichor` on npm is an unrelated placeholder — `npx ichor` would fetch and
    // run a stranger's package on every edit.
    const command = read('.claude/settings.json').hooks.PreToolUse[0].hooks[0].command;
    expect(command.startsWith('npx')).toBe(false);
    expect(read('.mcp.json').mcpServers.ichor.command).not.toBe('npx');
  });

  it('merges into existing config instead of clobbering it', () => {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude/settings.json'),
      JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }),
      'utf8',
    );

    installHooks(repo);
    const settings = read('.claude/settings.json');

    expect(settings.model).toBe('opus');
    expect(settings.hooks.PreToolUse).toHaveLength(2);
  });

  it('is idempotent', () => {
    installHooks(repo);
    installHooks(repo);
    expect(read('.claude/settings.json').hooks.PreToolUse).toHaveLength(1);
    expect(read('.codex/hooks.json').hooks.PreToolUse).toHaveLength(1);
  });
});
