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

import { COMPOSE_FILE } from '../stack/compose.js';
import { writeStack } from '../stack/stack.js';

/** Matches file-editing tools across both hosts. Codex reports apply_patch. */
const MATCHER = 'Edit|Write|MultiEdit|apply_patch';

/**
 * Deliberately `ichor`, not `npx ichor`.
 *
 * The npm name is `ichor-cli` because `ichor` is already taken by an unrelated
 * 0.0.0 placeholder. `npx ichor hook` would therefore MISS locally and download
 * a stranger's package, then run it on every edit the agent makes. A hook is
 * the last place to accept that risk, so we call the binary that `npm i -g
 * ichor-cli` puts on PATH and fail loudly if it is absent.
 */
const COMMAND = 'ichor hook';

export interface InstallResult {
  messages: string[];
  claudeCode: boolean;
  codex: boolean;
}

export function installHooks(repoRoot: string): InstallResult {
  const messages: string[] = [];
  const claudeCode = installClaudeCode(repoRoot, messages);
  const codex = installCodex(repoRoot, messages);
  installMcp(repoRoot, messages);

  // A global `npm i -g ichor-cli` gives you the CLI and nothing to run it
  // against, so init also drops the graph database next to the hooks.
  writeStack(repoRoot);
  messages.push(`  HydraDB stack: written -> ${COMPOSE_FILE}`);

  return { messages, claudeCode, codex };
}

/**
 * Register the MCP server so the agent can ask why and argue back.
 *
 * Both hosts read `.mcp.json` at the repo root, so one file covers both. This is
 * the collaboration layer, not the enforcement layer — an agent can decline to
 * call a tool, which is exactly why the hook exists as well.
 */
function installMcp(repoRoot: string, messages: string[]): void {
  const file = path.join(repoRoot, '.mcp.json');
  const config = readJson(file);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

  if (servers.ichor) {
    messages.push('  MCP server: already registered');
    return;
  }

  servers.ichor = {
    type: 'stdio',
    command: 'ichor',
    args: ['mcp', '--repo', '.'],
  };

  writeJson(file, { ...config, mcpServers: servers });
  messages.push(`  MCP server: registered -> ${display(repoRoot, file)}`);
}

/** Config paths read the same on Windows as everywhere else. */
function display(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
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
  messages.push(`  Claude Code: hook installed -> ${display(repoRoot, file)}`);
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

  // The SAME nested shape as Claude Code, not a flattened one.
  //
  // Codex reads `<repo>/.codex/hooks.json` happily, but each PreToolUse entry
  // must carry its own `hooks` ARRAY. An entry with `type`/`command` hoisted to
  // the top level parses without complaint and then runs nothing at all — Codex
  // edited a whole repo unpoliced with no error anywhere. Silent, which is the
  // worst possible failure for a tool whose entire job is to speak up.
  preToolUse.push({
    matcher: MATCHER,
    hooks: [{ type: 'command', command: COMMAND }],
  });

  writeJson(file, { ...config, hooks: { ...hooks, PreToolUse: preToolUse } });
  messages.push(`  Codex: hook installed -> ${display(repoRoot, file)}`);
  messages.push('    (Codex asks you to review and trust a new hook on first run)');
  return true;
}
