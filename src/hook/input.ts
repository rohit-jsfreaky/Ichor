/**
 * Turn a host-specific PreToolUse payload into Ichor's common event.
 *
 * This is the whole adapter layer (PROJECT_FINAL.md §38, §45). The scope engine
 * must never learn that Claude Code and Codex describe an edit differently, so
 * all host knowledge is confined to this file. A new agent is a new branch here
 * and nothing else.
 *
 * The two we support today:
 *
 *   Claude Code  Edit / Write / MultiEdit
 *                tool_input.file_path, plus content or old/new strings
 *
 *   Codex        apply_patch  (matcher also accepts Edit / Write as aliases,
 *                but tool_name still reports "apply_patch")
 *                tool_input.command holds a whole patch, which can touch
 *                several files at once
 */

import * as path from 'node:path';
import type { ChangeIntent } from '../scope/classify.js';

export interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  [key: string]: unknown;
}

export interface ParsedHookInput {
  /** Which host we think sent this — reported, never used to change the verdict. */
  agent: 'claude-code' | 'codex' | 'unknown';
  toolName: string;
  /** One entry per file the tool call would touch. */
  intents: ChangeIntent[];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

/** True when this tool call could modify a file. Everything else is ignored. */
export function isEditingTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

export function parseHookInput(payload: HookPayload, repoRoot: string): ParsedHookInput {
  const toolName = String(payload.tool_name ?? '');
  const input = payload.tool_input ?? {};

  // Codex: a patch string that may add, update or delete several files.
  if (typeof input.command === 'string' && /\*\*\*\s*(Begin Patch|Add File|Update File|Delete File)/.test(input.command)) {
    return { agent: 'codex', toolName, intents: parseApplyPatch(input.command, repoRoot) };
  }

  // Claude Code: a single file per call.
  const filePath = firstString(input, ['file_path', 'filePath', 'path']);
  if (filePath) {
    const file = toRepoRelative(filePath, repoRoot);
    const content = firstString(input, ['content', 'new_string', 'newString']);
    // Write with content and no prior file is a create; Edit implies it exists.
    const operation: ChangeIntent['operation'] =
      toolName === 'Write' && input.content !== undefined ? 'create' : 'edit';

    return { agent: 'claude-code', toolName, intents: [{ operation, file, content }] };
  }

  return { agent: 'unknown', toolName, intents: [] };
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Absolute or relative host path -> repo-relative POSIX path. */
export function toRepoRelative(filePath: string, repoRoot: string): string {
  const normalised = filePath.replace(/\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalised.startsWith(root)) return normalised.slice(root.length).replace(/^\//, '');
  if (path.isAbsolute(normalised)) return path.posix.normalize(normalised).replace(/^\//, '');
  return normalised.replace(/^\.\//, '');
}

/**
 * Parse OpenAI's apply_patch envelope.
 *
 *   *** Begin Patch
 *   *** Add File: src/app/api/x/route.ts
 *   +import ...
 *   *** Update File: src/lib/y.ts
 *   @@
 *   -old
 *   +new
 *   *** End Patch
 *
 * For an added file the `+` lines ARE the whole content, which is what lets a
 * brand-new file be classified by what it reaches rather than by being new.
 */
export function parseApplyPatch(patch: string, repoRoot: string): ChangeIntent[] {
  const intents: ChangeIntent[] = [];
  const lines = patch.split(/\r?\n/);

  let current: { operation: ChangeIntent['operation']; file: string; added: string[] } | undefined;

  const flush = () => {
    if (!current) return;
    intents.push({
      operation: current.operation,
      file: current.file,
      // Only an added file's `+` lines form complete content. For an update they
      // are a fragment, and a fragment parsed as a module would be misleading.
      content: current.operation === 'create' && current.added.length ? current.added.join('\n') : undefined,
    });
    current = undefined;
  };

  for (const line of lines) {
    const header = /^\*\*\*\s*(Add|Update|Delete)\s+File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      flush();
      const kind = header[1];
      current = {
        operation: kind === 'Add' ? 'create' : kind === 'Delete' ? 'delete' : 'edit',
        file: toRepoRelative(header[2], repoRoot),
        added: [],
      };
      continue;
    }
    if (/^\*\*\*\s*(Begin|End) Patch/.test(line)) {
      if (/End Patch/.test(line)) flush();
      continue;
    }
    if (current && line.startsWith('+')) current.added.push(line.slice(1));
  }

  flush();
  return intents;
}
