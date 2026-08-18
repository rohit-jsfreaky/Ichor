/**
 * Ichor's retrieval, reachable from a shell.
 *
 * WHY THIS EXISTS, MEASURED RATHER THAN ASSUMED.
 *
 * Ichor's graph search shipped only as MCP tools, and MCP turned out to be the one
 * door the agent stopped walking through. Claude Code injects this into every
 * auto-mode turn for some models:
 *
 *   "read files with cat, head, or sed -n, SEARCH WITH GREP AND FIND, and make
 *    file changes with sed, heredocs, or short scripts, rather than using the
 *    dedicated Read, Edit, or Write tools."
 *
 * Counted across one repository's sessions: every turn WITHOUT that instruction
 * used ichor's tools (4, 3 and 5 calls in three sessions); every turn WITH it used
 * them zero times and never even loaded their descriptions. The briefing was
 * telling the agent "use these instead of guessing at grep patterns" while the
 * platform told it "search with grep" — and the platform speaks from the system
 * position, every turn.
 *
 * Arguing with that is a losing position, and gating it is impossible. So the
 * answer is to stop needing MCP: the instruction says reach for the shell, and
 * these commands ARE the shell. `ichor find "where uploads retry"` is a shell
 * command, which is exactly what the agent has been told to prefer. The steer
 * stops working against Ichor and starts working for it.
 *
 * ONE IMPLEMENTATION, TWO DOORS. Every command here dispatches into `runTool` —
 * the same function the MCP server calls, with the same arguments and the same
 * budget. A second implementation would drift, and two retrieval paths that
 * disagree about what the graph says is worse than one that is awkward to reach
 * (ENGINEERING-RULES rule 3).
 */

import { GraphClient, configFromEnv } from './graph/client.js';
import { runTool } from './mcp/server.js';
import { loadTask } from './state.js';
import type { PersistedTask } from './state.js';

/** Tools reachable from the shell, and how their words map onto MCP arguments. */
export type RetrievalCommand = 'find' | 'impact' | 'paths' | 'callers' | 'check' | 'scope' | 'explain';

const TOOL_FOR: Record<RetrievalCommand, string> = {
  find: 'ichor_find',
  impact: 'ichor_impact',
  paths: 'ichor_paths',
  callers: 'ichor_callers',
  check: 'ichor_check_change',
  scope: 'ichor_get_scope',
  explain: 'ichor_explain',
};

/**
 * Run one retrieval command and return what the agent would have been told.
 *
 * Returns the text rather than printing it, so the caller decides where it goes
 * and the function stays testable without capturing stdout.
 */
export async function retrieve(
  command: RetrievalCommand,
  args: Record<string, unknown>,
  repoRoot: string,
): Promise<string> {
  const client = new GraphClient(configFromEnv());

  /**
   * Some tools need an active task and some do not.
   *
   * `find`, `impact` and `paths` answer questions about the codebase and work
   * with no task at all — which matters, because the most useful moment to ask
   * "where does this live" is before any task exists. The scope-shaped tools
   * genuinely cannot answer without one, and say so in a sentence rather than
   * throwing a stack trace at a person.
   */
  const requireTask = (): PersistedTask => {
    const task = loadTask(repoRoot);
    if (!task) {
      throw new Error(
        'No task is being tracked, so there is no scope to report. ' +
          'Run `ichor watch` and prompt your agent, or `ichor start "<task>"`.',
      );
    }
    return task;
  };

  try {
    return await runTool(TOOL_FOR[command], args, repoRoot, requireTask, () => client);
  } finally {
    await client.close().catch(() => undefined);
  }
}
