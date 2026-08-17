/**
 * Reporting an edit Ichor never saw (bug 17).
 *
 * In one live session a file was modified — `git status` confirmed it — and
 * `.ichor/hook.log` recorded the prompt and then nothing: no edit event, no stop
 * event. The cause was never established. It is consistent with the documented
 * limit that a write which does not go through an edit tool is invisible, and the
 * agent in that turn was hitting permission walls on `node` and `npx`, so a shell
 * write is plausible. That remains a guess: the transcript is gone and it did not
 * recur.
 *
 * The gap itself cannot be closed from inside a PreToolUse hook — you cannot be
 * called for something that never calls you. What CAN be fixed is the silence
 * around it. Without a record of what Ichor did judge, a missed edit and a
 * deliberately-allowed edit look identical in the log, so "Ichor said nothing"
 * cannot be read as "nothing was out of scope".
 *
 * These tests pin the three properties that make the report worth reading:
 * it names an unjudged change, it stays quiet about judged ones, and it ignores a
 * repo that was already dirty before the task opened.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { unseenEditDetails, unseenEdits } from '../src/hook/stop.js';
import { loadTask, markJudged, markUnseenReported, saveTask, updateTask } from '../src/state.js';
import type { Neighborhood } from '../src/scope/neighborhood.js';

let repo: string;

/** A real git repo — `unseenEdits` asks git what changed, so a fake will not do. */
beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ichor-unseen-')));
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
  const members = new Map([
    [1000, { id: 1000, name: 'createVendor', file: 'src/create.ts', distance: 0, reason: 'anchor' }],
  ]);
  return {
    task,
    terms: task.split(' '),
    anchors: [],
    members,
    models: new Map(),
    coreModels: new Set<string>(),
    stats: { anchorCount: 0, memberCount: 1, maxDistance: 0, queryCount: 0, truncated: false, hubsSkipped: 0, durationMs: 0 },
  };
}

/** Write a file and give it an mtime clearly after the task opened. */
function writeAfterStart(rel: string, contents = 'export const b = 2;\n'): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(full, future, future);
}

describe('an edit Ichor never judged', () => {
  it('is named at the end of the turn', () => {
    saveTask(repo, neighborhood('fix duplicate email handling'));
    writeAfterStart('src/written-by-a-shell.ts');

    expect(unseenEdits(repo, loadTask(repo)!)).toEqual(['src/written-by-a-shell.ts']);
  });

  it('is named even when written in the same instant the task opened', () => {
    // No clock tampering in this one, and that is the whole point.
    //
    // `startedAt` is an ISO string truncated to whole milliseconds; `mtimeMs`
    // carries a fraction. A strict comparison between them is a coin flip when
    // the write lands in the same millisecond as the prompt — measured at three
    // reports out of five identical runs before `MTIME_SLACK_MS` existed. The
    // other tests here all set an mtime seconds away and sailed past it.
    saveTask(repo, neighborhood('fix duplicate email handling'));
    const full = path.join(repo, 'src', 'written-immediately.ts');
    fs.writeFileSync(full, 'export const d = 4;\n');

    expect(unseenEdits(repo, loadTask(repo)!)).toEqual(['src/written-immediately.ts']);
  });

  it('is not named once it has a verdict', () => {
    saveTask(repo, neighborhood('fix duplicate email handling'));
    writeAfterStart('src/judged.ts');
    // Every file that reaches a decision is recorded, including allowed ones —
    // silence leaves no other trace.
    markJudged(repo, ['src/judged.ts']);

    expect(unseenEdits(repo, loadTask(repo)!)).toEqual([]);
  });

  it('counts a challenged file as accounted for', () => {
    saveTask(repo, neighborhood('fix duplicate email handling'));
    writeAfterStart('src/challenged.ts');
    updateTask(repo, (t) => ({ ...t, challenged: ['src/challenged.ts'] }));

    expect(unseenEdits(repo, loadTask(repo)!)).toEqual([]);
  });

  it('counts a file Ichor parsed as seen, even without a verdict', () => {
    saveTask(repo, neighborhood('fix duplicate email handling'));
    writeAfterStart('src/parsed.ts');
    updateTask(repo, (t) => ({
      ...t,
      overlay: [
        { path: 'src/parsed.ts', calls: [], imports: [], touches: [], routeMethods: [], at: new Date().toISOString() },
      ],
    }));

    expect(unseenEdits(repo, loadTask(repo)!)).toEqual([]);
  });
});

describe('reported once per change, not once per turn', () => {
  /**
   * Found in a real session, not by a test.
   *
   * A file written outside an edit tool can never acquire a verdict, because no
   * hook will ever fire for it. So "report until judged" means "report forever":
   * the same line appeared at the end of a later turn that made no edits at all,
   * printed directly above "graph matches the code -> no rebuild".
   */
  it('goes quiet on the next turn', () => {
    saveTask(repo, neighborhood('fix duplicate email handling'));
    writeAfterStart('src/written-by-a-shell.ts');

    const first = unseenEditDetails(repo, loadTask(repo)!);
    expect(first.map((u) => u.file)).toEqual(['src/written-by-a-shell.ts']);

    // What handleStop does after logging.
    markUnseenReported(repo, first);

    expect(unseenEdits(repo, loadTask(repo)!)).toEqual([]);
  });

  it('speaks up again if the same file genuinely changes again', () => {
    // Suppressing a repeat must not suppress new information. A second hand-write
    // to the same file is a new unjudged change and has to be named.
    saveTask(repo, neighborhood('fix duplicate email handling'));
    writeAfterStart('src/twice.ts');
    markUnseenReported(repo, unseenEditDetails(repo, loadTask(repo)!));
    expect(unseenEdits(repo, loadTask(repo)!)).toEqual([]);

    writeAfterStart('src/twice.ts', 'export const changed = true;\n');

    expect(unseenEdits(repo, loadTask(repo)!)).toEqual(['src/twice.ts']);
  });
});

describe('what must not be reported', () => {
  it('ignores changes that predate the task', () => {
    // A repo that was already dirty when the task opened is not evidence of a
    // missed hook. Reporting it would make this line worthless inside one
    // session, which is the only place it can be read.
    const full = path.join(repo, 'src', 'dirty-beforehand.ts');
    fs.writeFileSync(full, 'export const c = 3;\n');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(full, past, past);

    saveTask(repo, neighborhood('fix duplicate email handling'));

    expect(unseenEdits(repo, loadTask(repo)!)).toEqual([]);
  });

  it('says nothing when the working tree is clean', () => {
    saveTask(repo, neighborhood('fix duplicate email handling'));
    expect(unseenEdits(repo, loadTask(repo)!)).toEqual([]);
  });
});

describe('a repo watched from inside a larger git repo', () => {
  /**
   * `ichor init` inside `backend/` of a monorepo — an ordinary thing to do, and
   * the one arrangement no other suite used.
   *
   * `git status` reports paths relative to the GIT ROOT, not to the directory it
   * ran in, so every path arrived with `backend/` on the front and got joined
   * onto the watched root a second time. Nothing failed: the stat threw, the
   * throw was read as "the file was deleted", and a rebuild fired after every
   * turn forever.
   */
  it('reports paths relative to the watched root, not the git root', () => {
    const watched = path.join(repo, 'packages', 'backend');
    fs.mkdirSync(path.join(watched, 'src'), { recursive: true });

    saveTask(watched, neighborhood('fix duplicate email handling'));
    fs.writeFileSync(path.join(watched, 'src', 'inner.ts'), 'export const e = 5;\n');

    // `src/inner.ts`, NOT `packages/backend/src/inner.ts`.
    expect(unseenEdits(watched, loadTask(watched)!)).toEqual(['src/inner.ts']);
  });

  it('ignores a sibling package it is not watching', () => {
    // A monorepo's other packages are not this task's repository and never were.
    const watched = path.join(repo, 'packages', 'backend');
    const sibling = path.join(repo, 'packages', 'frontend');
    fs.mkdirSync(path.join(watched, 'src'), { recursive: true });
    fs.mkdirSync(path.join(sibling, 'src'), { recursive: true });

    saveTask(watched, neighborhood('fix duplicate email handling'));
    fs.writeFileSync(path.join(sibling, 'src', 'elsewhere.ts'), 'export const f = 6;\n');

    expect(unseenEdits(watched, loadTask(watched)!)).toEqual([]);
  });
});
