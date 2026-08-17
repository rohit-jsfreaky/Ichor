/**
 * Turn a host-specific PreToolUse payload into Ichor's common event.
 *
 * This is the whole adapter layer. The scope engine must never learn that Claude
 * Code and Codex describe an edit differently, so all host knowledge is confined
 * to this file: a new agent is a new branch here and nothing else.
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
  /**
   * Paths the tool call touches that are not in this repository.
   *
   * Kept separate rather than dropped, so the hook can say it saw them. Ichor has
   * no opinion about a file outside the tree it was pointed at — it has not read
   * that code, has no graph for it, and cannot have a view on whether editing it
   * is scope expansion.
   */
  outside: string[];
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
    return { agent: 'codex', toolName, ...parseApplyPatch(input.command, repoRoot) };
  }

  // Claude Code: a single file per call.
  const filePath = firstString(input, ['file_path', 'filePath', 'path']);
  if (filePath) {
    const file = toRepoRelative(filePath, repoRoot);
    if (file === undefined) {
      return { agent: 'claude-code', toolName, intents: [], outside: [filePath] };
    }

    const content = firstString(input, ['content', 'new_string', 'newString']);
    // Write with content and no prior file is a create; Edit implies it exists.
    const operation: ChangeIntent['operation'] =
      toolName === 'Write' && input.content !== undefined ? 'create' : 'edit';

    /**
     * The substitution an Edit is about to make.
     *
     * `new_string` on its own is a FRAGMENT. Passing it to the parser as if it
     * were a module is how a file that removes a widely-used export looked
     * identical to one that changed a function's insides — the fragment shows
     * what arrived, never what left. With both halves the caller can read the file
     * from disk, which at PreToolUse is still the old version, and reconstruct
     * exactly what the file is about to become.
     */
    const from = firstString(input, ['old_string', 'oldString']);
    const to = typeof input.new_string === 'string' ? input.new_string : undefined;
    const replace = from !== undefined && to !== undefined ? { from, to } : undefined;

    return {
      agent: 'claude-code',
      toolName,
      intents: [{ operation, file, content, replace }],
      outside: [],
    };
  }

  return { agent: 'unknown', toolName, intents: [], outside: [] };
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Host path -> repo-relative POSIX path, or `undefined` if it is not in the repo.
 *
 * The `undefined` is the point. This used to hand back
 * `C:/Users/…/AppData/Local/Temp/fixcn.js` with the leading slash stripped, and
 * the classifier then judged it like any other file — so an agent writing a
 * scratch script to the system temp directory got challenged for scope expansion
 * on a file in no repository at all.
 *
 * Everything is compared case-insensitively and after resolving `..`, because
 * `D:\repo\..\repo\src\x.ts` and `d:/REPO/src/x.ts` are the same file and only one
 * of the two spellings used to match. A path leaving the root through `..` is
 * outside, whatever it looks like on the way.
 */
export function toRepoRelative(filePath: string, repoRoot: string): string | undefined {
  const slashed = filePath.replace(/\\/g, '/');
  const root = path.posix.normalize(repoRoot.replace(/\\/g, '/')).replace(/\/$/, '');

  // A relative path is relative to the root, so join before resolving `..`.
  const absolute = path.posix.isAbsolute(slashed) || /^[a-zA-Z]:\//.test(slashed)
    ? path.posix.normalize(slashed)
    : path.posix.normalize(`${root}/${slashed.replace(/^\.\//, '')}`);

  // Windows paths differ only in case surprisingly often — the host may report a
  // lowercase drive letter where the config has an uppercase one.
  const inside = (child: string, parent: string) => {
    const c = child.toLowerCase();
    const p = parent.toLowerCase();
    return c === p || c.startsWith(`${p}/`);
  };

  if (!inside(absolute, root)) return undefined;
  return absolute.slice(root.length).replace(/^\//, '');
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
export function parseApplyPatch(
  patch: string,
  repoRoot: string,
): { intents: ChangeIntent[]; outside: string[] } {
  const intents: ChangeIntent[] = [];
  const outside: string[] = [];
  const lines = patch.split(/\r?\n/);

  let current:
    | { operation: ChangeIntent['operation']; file: string | undefined; added: string[] }
    | undefined;

  const flush = () => {
    if (!current) return;
    if (current.file !== undefined) {
      intents.push({
        operation: current.operation,
        file: current.file,
        // Only an added file's `+` lines form complete content. For an update they
        // are a fragment, and a fragment parsed as a module would be misleading.
        content: current.operation === 'create' && current.added.length ? current.added.join('\n') : undefined,
      });
    }
    current = undefined;
  };

  for (const line of lines) {
    const header = /^\*\*\*\s*(Add|Update|Delete)\s+File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      flush();
      const kind = header[1];
      const file = toRepoRelative(header[2]!, repoRoot);
      if (file === undefined) outside.push(header[2]!);
      current = {
        operation: kind === 'Add' ? 'create' : kind === 'Delete' ? 'delete' : 'edit',
        file,
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
  return { intents, outside };
}
