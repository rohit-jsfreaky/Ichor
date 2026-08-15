/**
 * Wire Ichor into Claude Code and Codex.
 *
 * Both call the same command with the same payload shape and accept the same
 * decision JSON. Only the config file differs, which is the whole reason
 * supporting two agents costs an afternoon rather than a week:
 *
 *   Claude Code   .claude/settings.json   hooks.PreToolUse[].hooks[]
 *   Codex         .codex/hooks.json       hooks.PreToolUse[]
 *
 * Existing config is merged, never overwritten — clobbering somebody's hooks
 * would be a serious breach of trust for a tool that installs itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Matches file-editing tools across both hosts. Codex reports apply_patch. */
const MATCHER = 'Edit|Write|MultiEdit|apply_patch';
const COMMAND = 'npx ichor hook';

export interface InstallResult {
  messages: string[];
  claudeCode: boolean;
  codex: boolean;
}

export function installHooks(repoRoot: string): InstallResult {
  const messages: string[] = [];
  const claudeCode = installClaudeCode(repoRoot, messages);
  const codex = installCodex(repoRoot, messages);
  return { messages, claudeCode, codex };
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // Never silently discard a config we could not parse.
    throw new Error(`${file} exists but is not valid JSON — fix or move it, then re-run ichor init`);
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Is an Ichor hook already registered here? */
function alreadyInstalled(entries: unknown): boolean {
  return JSON.stringify(entries ?? '').includes('ichor hook');
}

function installClaudeCode(repoRoot: string, messages: string[]): boolean {
  const file = path.join(repoRoot, '.claude', 'settings.json');
  const settings = readJson(file);

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...(hooks.PreToolUse as unknown[])] : [];

  if (alreadyInstalled(preToolUse)) {
    messages.push('  Claude Code: already installed');
    return true;
  }

  preToolUse.push({
    matcher: MATCHER,
    hooks: [{ type: 'command', command: COMMAND }],
  });

  writeJson(file, { ...settings, hooks: { ...hooks, PreToolUse: preToolUse } });
  messages.push(`  Claude Code: hook installed -> ${path.relative(repoRoot, file)}`);
  return true;
}

function installCodex(repoRoot: string, messages: string[]): boolean {
  const file = path.join(repoRoot, '.codex', 'hooks.json');
  const config = readJson(file);

  const hooks = (config.hooks ?? {}) as Record<string, unknown>;
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...(hooks.PreToolUse as unknown[])] : [];

  if (alreadyInstalled(preToolUse)) {
    messages.push('  Codex: already installed');
    return true;
  }

  preToolUse.push({
    matcher: MATCHER,
    type: 'command',
    command: COMMAND,
  });

  writeJson(file, { ...config, hooks: { ...hooks, PreToolUse: preToolUse } });
  messages.push(`  Codex: hook installed -> ${path.relative(repoRoot, file)}`);
  messages.push('    (Codex asks you to review and trust a new hook on first run)');
  return true;
}
