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
