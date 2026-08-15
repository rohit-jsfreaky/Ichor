/**
 * The agent has finished talking.
 *
 * This is the only moment in a session when the expensive work is free: the
 * human is reading the answer, nothing is half-written, and no edit is in
 * flight. So it is where the graph gets rebuilt.
 *
 * The handler itself does almost nothing — it decides whether a rebuild is
 * warranted and hands off to a detached process. The agent is waiting on this
 * hook to exit, so it must never do the ~3 seconds of analysis inline.
 */

import { needsRefresh, spawnRefresh } from '../refresh/refresh.js';
import { loadTask } from '../state.js';

export function handleStop(repoRoot: string): string[] {
  const log: string[] = [];

  const task = loadTask(repoRoot);
  if (!task) return ['stop: no active task -> nothing to refresh'];

  const staleness = needsRefresh(repoRoot);
  if (!staleness.stale) return [`stop: ${staleness.why} -> no rebuild`];

  const result = spawnRefresh(repoRoot);
  log.push(
    result.spawned
      ? `stop: ${staleness.why} -> rebuild started (${result.why})`
      : `stop: wanted a rebuild (${staleness.why}) but could not start one — ${result.why}`,
  );
  return log;
}
