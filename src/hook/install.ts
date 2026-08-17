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
import * as os from 'node:os';
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
  const allowed = allowMcpTools(repoRoot, settings, messages);
  if (added.length === 0 && !allowed) return true;

  writeJson(file, { ...settings, hooks, permissions: settings.permissions });
  if (added.length > 0) {
    messages.push(`  Claude Code: ${added.join(', ')} -> ${display(repoRoot, file)}`);
  }
  return true;
}

/**
 * Let the agent call Ichor's own tools without being asked each time.
 *
 * Registering the MCP server is not the same as permitting its tools. Without this
 * the first session raises a permission prompt PER TOOL — tolerable when a human is
 * watching, and invisible until you run headless, where the prompt cannot be
 * answered and the tools simply never work.
 *
 * Merged into whatever is already there, never overwritten, exactly as the hooks
 * are: a developer's existing `permissions.allow` is theirs.
 */
function allowMcpTools(
  repoRoot: string,
  settings: Record<string, unknown>,
  messages: string[],
): boolean {
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : [];

  // The prefix covers every current and future Ichor tool. Listing them one by one
  // would silently stop covering the next one added.
  const rule = 'mcp__ichor';
  if (allow.some((entry) => typeof entry === 'string' && entry.startsWith(rule))) {
    messages.push('  MCP tools: already allowed');
    return false;
  }

  allow.push(rule);
  settings.permissions = { ...permissions, allow };
  messages.push(`  MCP tools: allowed without prompting (permissions.allow += "${rule}")`);

  /**
   * Say so when the entry will be ignored.
   *
   * Claude Code discards `permissions.allow` from a project's settings until the
   * workspace is trusted, and untrusted is the DEFAULT for a fresh clone — so the
   * line above was, on its own, a promise the tool could not keep. It reports the
   * fact rather than silently doing nothing, and never edits the user's global
   * config to force it: a tool that grants itself trust in a file the user owns has
   * answered the wrong question.
   */
  if (!workspaceTrusted(repoRoot)) {
    messages.push('    ⚠ Claude Code ignores this until the workspace is trusted, which is the');
    messages.push('      default for a fresh clone. Run `claude` here once and accept the dialog.');
    messages.push('      Hooks and verdicts work either way — only this pre-approval waits.');
  }
  return true;
}

/**
 * Has this workspace been trusted in Claude Code?
 *
 * Read-only, and deliberately so. The answer lives in the user's own
 * `~/.claude.json`, and Ichor's business is reporting what it found there, not
 * changing it. Returns true when it cannot tell, so an unreadable config produces a
 * silence rather than a warning about a problem that may not exist.
 */
function workspaceTrusted(repoRoot: string): boolean {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'),
    ) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };

    const wanted = path.resolve(repoRoot).replace(/\\/g, '/').toLowerCase();
    for (const [key, value] of Object.entries(config.projects ?? {})) {
      if (key.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === wanted) {
        return value.hasTrustDialogAccepted === true;
      }
    }
    // Never opened here. Claude Code will ask on first run, so the warning applies.
    return false;
  } catch {
    return true;
  }
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
