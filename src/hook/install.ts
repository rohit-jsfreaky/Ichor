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

/**
 * The three events Ichor listens to, and whether the entry carries a matcher.
 *
 * `PreToolUse` filters by tool name. Neither host supports a matcher on the
 * other two — Claude Code documents them as always firing, and Codex ignores any
 * matcher it finds — so we omit it rather than write a field that silently means
 * nothing.
 */
const EVENTS: { name: string; matcher?: string }[] = [
  { name: 'PreToolUse', matcher: MATCHER },
  { name: 'UserPromptSubmit' },
  { name: 'Stop' },
];

/**
 * Add Ichor to one event array, leaving everything else in the file alone.
 *
 * Always the NESTED shape — an entry carrying its own `hooks` array. Codex will
 * read a flattened entry (`type`/`command` hoisted to the top level) without a
 * word of complaint and then run nothing at all; it edited an entire repo
 * unpoliced that way. Silence is the worst possible failure for a tool whose job
 * is to speak up, so both hosts get the shape that is verified to work.
 */
function registerEvents(
  hooks: Record<string, unknown>,
  messages: string[],
  label: string,
): { hooks: Record<string, unknown>; added: string[] } {
  const next = { ...hooks };
  const added: string[] = [];

  for (const event of EVENTS) {
    const existing = Array.isArray(next[event.name]) ? [...(next[event.name] as unknown[])] : [];
    // Scoped per event: the same command in a different event's array must not
    // count as "already installed here".
    if (alreadyInstalled(existing)) continue;

    existing.push({
      ...(event.matcher ? { matcher: event.matcher } : {}),
      hooks: [{ type: 'command', command: COMMAND }],
    });
    next[event.name] = existing;
    added.push(event.name);
  }

  if (added.length === 0) messages.push(`  ${label}: already installed`);
  return { hooks: next, added };
}

function installClaudeCode(repoRoot: string, messages: string[]): boolean {
  const file = path.join(repoRoot, '.claude', 'settings.json');
  const settings = readJson(file);
  const current = (settings.hooks ?? {}) as Record<string, unknown>;

  const { hooks, added } = registerEvents(current, messages, 'Claude Code');
  if (added.length === 0) return true;

  writeJson(file, { ...settings, hooks });
  messages.push(`  Claude Code: ${added.join(', ')} -> ${display(repoRoot, file)}`);
  return true;
}

function installCodex(repoRoot: string, messages: string[]): boolean {
  const file = path.join(repoRoot, '.codex', 'hooks.json');
  const config = readJson(file);
  const current = (config.hooks ?? {}) as Record<string, unknown>;

  const { hooks, added } = registerEvents(current, messages, 'Codex');
  if (added.length === 0) return true;

  writeJson(file, { ...config, hooks });
  messages.push(`  Codex: ${added.join(', ')} -> ${display(repoRoot, file)}`);
  messages.push('    (Codex asks you to review and trust a new hook on first run)');
  return true;
}
