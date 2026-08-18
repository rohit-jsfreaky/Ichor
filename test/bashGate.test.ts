/**
 * Detecting file changes that arrived through a shell command.
 *
 * These tests exist because of a measured failure, not a hypothetical one. Claude
 * Code began instructing agents to "make file changes with sed, heredocs, or short
 * scripts, rather than using the dedicated Read, Edit, or Write tools", and across
 * three consecutive sessions on a real repository every edit went through a
 * heredoc. Ichor's PreToolUse gate fired for none of them, and its Stop handler
 * reported afterwards: "1 file(s) changed that Ichor never judged".
 *
 * Detection is the half that can be tested without a database, so it is tested
 * hard here: the judging half needs a graph and lives in the hook and session
 * harnesses. What is pinned below is that the gate finds a shell write, stays
 * quiet about everything it has already accounted for, and — crucially — does not
 * re-ask about the same content on every subsequent command. That last property
 * is what makes it affordable to run after EVERY shell call, and it is invisible
 * until it breaks.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectBashChanges, loadGateState, saveGateState } from '../src/hook/bashGate.js';
import { loadTask, markJudged, saveTask, updateTask } from '../src/state.js';
import type { Neighborhood } from '../src/scope/neighborhood.js';

let repo: string;

/** A real git repo: detection asks git what changed, so a fake directory will not do. */
beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ichor-bashgate-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'committed.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function neighborhood(task: string): Neighborhood {
  return {
    task,
    terms: task.split(' '),
    anchors: [],
    members: new Map([
      [1000, { id: 1000, name: 'createVendor', file: 'src/create.ts', distance: 0, reason: 'anchor' }],
    ]),
    models: new Map(),
    coreModels: new Set<string>(),
    stats: {
      anchorCount: 0,
      memberCount: 1,
      maxDistance: 0,
      queryCount: 0,
      truncated: false,
      hubsSkipped: 0,
      durationMs: 0,
    },
  };
}

/** Write a file with an mtime clearly after the task opened, as a shell command would. */
function shellWrite(rel: string, contents = 'export const b = 2;\n'): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(full, future, future);
}

const start = (task = 'fix duplicate email handling') => {
  saveTask(repo, neighborhood(task));
  return loadTask(repo)!;
};

describe('finding what a shell command changed', () => {
  it('finds a file written without any edit tool', () => {
    const task = start();
    shellWrite('src/written-by-a-heredoc.ts');

    const found = detectBashChanges(repo, task, loadGateState(repo, task));

    expect(found.candidates.map((c) => c.file)).toEqual(['src/written-by-a-heredoc.ts']);
    expect(found.candidates[0]!.operation).toBe('create');
  });

  it('tells an edit apart from a creation', () => {
    const task = start();
    // Already committed, so git reports it as modified rather than untracked.
    shellWrite('src/committed.ts', 'export const a = 99;\n');

    const found = detectBashChanges(repo, task, loadGateState(repo, task));

    expect(found.candidates[0]!.operation).toBe('edit');
  });

  it('says nothing when the command changed nothing', () => {
    const task = start();

    const found = detectBashChanges(repo, task, loadGateState(repo, task));

    expect(found.candidates).toEqual([]);
    expect(found.deletes).toEqual([]);
  });

  it('ignores files Ichor already decided on', () => {
    const task = start();
    shellWrite('src/already-seen.ts');
    markJudged(repo, ['src/already-seen.ts']);

    const found = detectBashChanges(repo, loadTask(repo)!, loadGateState(repo, task));

    expect(found.candidates).toEqual([]);
  });

  it('ignores a repo that was already dirty before the task opened', () => {
    // Written first, and back-dated well before the task starts. Challenging
    // somebody for their own uncommitted work is how a tool gets uninstalled.
    const full = path.join(repo, 'src', 'pre-existing.ts');
    fs.writeFileSync(full, 'export const c = 3;\n');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(full, past, past);

    const task = start();
    const found = detectBashChanges(repo, task, loadGateState(repo, task));

    expect(found.candidates).toEqual([]);
  });

  it('reports a deletion without challenging it', () => {
    const task = start();
    execFileSync('git', ['rm', '-q', 'src/committed.ts'], { cwd: repo });

    const found = detectBashChanges(repo, task, loadGateState(repo, task));

    expect(found.deletes).toEqual(['src/committed.ts']);
    expect(found.candidates).toEqual([]);
  });

  it('treats a rewrite of an already-challenged file as pushing through', () => {
    const task = start();
    shellWrite('src/contested.ts');
    updateTask(repo, (t) => ({ ...t, challenged: ['src/contested.ts'] }));

    const found = detectBashChanges(repo, loadTask(repo)!, loadGateState(repo, task));

    expect(found.forced).toEqual(['src/contested.ts']);
    expect(found.candidates).toEqual([]);
  });
});

describe('the high-water mark that makes this affordable', () => {
  /**
   * The property that decides whether this can run after EVERY shell command.
   *
   * git keeps reporting a file as dirty until it is committed, so without a
   * memory of what was already gated, one uncommitted file would be re-read and
   * re-classified after every command for the rest of the task.
   */
  it('does not re-ask about content it has already gated', () => {
    const task = start();
    shellWrite('src/one.ts');

    const gate = loadGateState(repo, task);
    const first = detectBashChanges(repo, task, gate);
    expect(first.candidates).toHaveLength(1);

    // Record it exactly as the judge loop does, then look again.
    const seen = first.candidates[0]!;
    gate.seen[seen.file] = { mtimeMs: seen.mtimeMs, size: seen.size };
    saveGateState(repo, gate);

    const second = detectBashChanges(repo, task, loadGateState(repo, task));
    expect(second.candidates).toEqual([]);
  });

  it('does ask again when the file genuinely changes', () => {
    const task = start();
    shellWrite('src/one.ts');

    const gate = loadGateState(repo, task);
    const first = detectBashChanges(repo, task, gate);
    const seen = first.candidates[0]!;
    gate.seen[seen.file] = { mtimeMs: seen.mtimeMs, size: seen.size };
    saveGateState(repo, gate);

    // A second, different write. Suppressing this would be the real bug.
    shellWrite('src/one.ts', 'export const b = 2;\nexport const d = 4;\n');

    const again = detectBashChanges(repo, task, loadGateState(repo, task));
    expect(again.candidates.map((c) => c.file)).toEqual(['src/one.ts']);
  });

  it('throws the memory away when the task changes', () => {
    const task = start('first job');
    shellWrite('src/one.ts');
    const gate = loadGateState(repo, task);
    gate.seen['src/one.ts'] = { mtimeMs: 1, size: 1 };
    saveGateState(repo, gate);

    // A new task means a new boundary, so nothing judged under the old one carries.
    saveTask(repo, neighborhood('a completely different job'));
    const fresh = loadGateState(repo, loadTask(repo)!);

    expect(fresh.seen).toEqual({});
  });

  it('reseeds rather than crashing on a corrupt state file', () => {
    const task = start();
    fs.writeFileSync(path.join(repo, '.ichor', 'bash-gate.json'), '{not json at all');

    expect(() => loadGateState(repo, task)).not.toThrow();
    expect(loadGateState(repo, task).seen).toEqual({});
  });
});
