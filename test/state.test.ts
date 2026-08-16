/**
 * Task state.
 *
 * Three things here are load-bearing and silent when they break:
 *   - history survival — a boundary that moves must not forget what it already
 *     asked about, or the agent gets re-challenged on the same file all day
 *   - forced-write memory — a bypassed challenge must never become ordinary
 *     history
 *   - atomicity — a hook, a background refresh and the CLI all write this file,
 *     and a half-written task.json reads as corrupt, which disables policing
 *     without a word
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  clearTask,
  loadTask,
  markChallenged,
  markForced,
  markJustified,
  recordOverlay,
  replaceBoundary,
  saveTask,
  taskPath,
  updateTask,
  writeAtomic,
  type PersistedTask,
} from '../src/state.js';
import type { Neighborhood } from '../src/scope/neighborhood.js';

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ichor-state-'));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function neighborhood(task: string, names: string[]): Neighborhood {
  const members = new Map(
    names.map((name, i) => [
      1000 + i,
      { id: 1000 + i, name, file: `src/${name}.ts`, distance: 0, reason: 'anchor' },
    ]),
  );
  return {
    task,
    terms: task.split(' '),
    anchors: [],
    members,
    models: new Map([[-1, { name: 'Vendor', viaFunction: '' }]]),
    coreModels: new Set(['Vendor']),
    stats: { anchorCount: 0, memberCount: members.size, maxDistance: 0, queryCount: 0, truncated: false, hubsSkipped: 0, durationMs: 0 },
  };
}

describe('atomic writes', () => {
  it('leaves no temp file behind', () => {
    writeAtomic(path.join(repo, '.ichor', 'x.json'), '{"a":1}\n');
    const files = fs.readdirSync(path.join(repo, '.ichor'));
    expect(files).toEqual(['x.json']);
  });

  it('replaces content wholesale rather than appending', () => {
    const file = path.join(repo, '.ichor', 'x.json');
    writeAtomic(file, 'a-long-first-value\n');
    writeAtomic(file, 'short\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('short\n');
  });
});

describe('moving the boundary', () => {
  it('keeps challenge history when the job did not change', () => {
    saveTask(repo, neighborhood('fix duplicate email', ['createVendor']));
    markChallenged(repo, 'src/app/api/vendors/check-email/route.ts');
    markJustified(repo, 'src/lib/auth/session.ts', 'the route authenticates first');

    replaceBoundary(repo, neighborhood('fix duplicate email', ['createVendor', 'submitVendor']), {
      resetHistory: false,
    });

    const task = loadTask(repo) as PersistedTask;
    expect(task.members).toHaveLength(2);
    expect(task.challenged).toContain('src/app/api/vendors/check-email/route.ts');
    expect(task.justified).toHaveLength(1);
  });

  it('drops challenge history when the job genuinely changed', () => {
    saveTask(repo, neighborhood('fix duplicate email', ['createVendor']));
    markChallenged(repo, 'src/lib/billing/invoice.ts');

    replaceBoundary(repo, neighborhood('fix billing rounding', ['createInvoice']), {
      resetHistory: true,
    });

    const task = loadTask(repo) as PersistedTask;
    expect(task.challenged).toEqual([]);
    // A file challenged under the old job must be fair game under the new one.
    expect(task.task).toBe('fix billing rounding');
  });

  it('returns undefined rather than inventing a task', () => {
    expect(replaceBoundary(repo, neighborhood('x', ['y']), { resetHistory: false })).toBeUndefined();
    expect(updateTask(repo, (t) => t)).toBeUndefined();
  });
});

describe('forced writes', () => {
  it('records a challenged file that was written anyway', () => {
    saveTask(repo, neighborhood('fix duplicate email', ['createVendor']));
    markChallenged(repo, 'src/app/api/vendors/check-email/route.ts');
    markForced(repo, 'src/app/api/vendors/check-email/route.ts');

    expect(loadTask(repo)?.forced.map((f) => f.file)).toEqual([
      'src/app/api/vendors/check-email/route.ts',
    ]);
  });

  it('does not record a file that was properly justified', () => {
    saveTask(repo, neighborhood('fix duplicate email', ['createVendor']));
    markChallenged(repo, 'src/lib/auth/session.ts');
    markJustified(repo, 'src/lib/auth/session.ts', 'genuinely required');
    markForced(repo, 'src/lib/auth/session.ts');

    expect(loadTask(repo)?.forced).toEqual([]);
  });

  it('does not record a file that was never challenged', () => {
    saveTask(repo, neighborhood('fix duplicate email', ['createVendor']));
    markForced(repo, 'src/lib/vendors/create.ts');
    expect(loadTask(repo)?.forced).toEqual([]);
  });

  it('survives starting a whole new task', () => {
    // The code is still in the repo and still was never justified. Forgetting it
    // is how a bypassed challenge turns into ordinary-looking history.
    saveTask(repo, neighborhood('fix duplicate email', ['createVendor']));
    markChallenged(repo, 'src/app/api/vendors/check-email/route.ts');
    markForced(repo, 'src/app/api/vendors/check-email/route.ts');

    saveTask(repo, neighborhood('fix billing rounding', ['createInvoice']));

    expect(loadTask(repo)?.forced).toHaveLength(1);
    expect(loadTask(repo)?.challenged).toEqual([]);
  });
});

describe('the overlay', () => {
  it('keeps one entry per file, latest write winning', () => {
    saveTask(repo, neighborhood('fix duplicate email', ['createVendor']));
    const entry = (calls: string[]) => ({
      path: 'src/lib/vendors/create.ts',
      calls,
      imports: [],
      touches: ['Vendor'],
      routeMethods: [],
      at: new Date().toISOString(),
    });

    recordOverlay(repo, [entry(['first'])]);
    recordOverlay(repo, [entry(['second'])]);

    const overlay = loadTask(repo)?.overlay ?? [];
    expect(overlay).toHaveLength(1);
    expect(overlay[0].calls).toEqual(['second']);
  });

  it('starts empty on a new task', () => {
    saveTask(repo, neighborhood('a', ['x']));
    recordOverlay(repo, [
      { path: 'a.ts', calls: [], imports: [], touches: [], routeMethods: [], at: 'now' },
    ]);
    saveTask(repo, neighborhood('b', ['y']));
    expect(loadTask(repo)?.overlay).toEqual([]);
  });
});

describe('reading state', () => {
  it('upgrades a task written by an older Ichor instead of dropping it', () => {
    // The developer is mid-task when they upgrade. Losing their boundary would
    // silently stop policing until they noticed and re-ran a command.
    const legacy = {
      version: 1,
      task: 'fix duplicate email',
      startedAt: new Date().toISOString(),
      repoRoot: repo,
      terms: ['duplicate', 'email'],
      anchors: [],
      members: [{ id: 1, name: 'createVendor', file: 'src/x.ts', distance: 0, reason: 'anchor' }],
      models: ['Vendor'],
      coreModels: ['Vendor'],
      challenged: ['src/a.ts'],
      justified: [],
    };
    fs.mkdirSync(path.join(repo, '.ichor'), { recursive: true });
    fs.writeFileSync(taskPath(repo), JSON.stringify(legacy), 'utf8');

    const task = loadTask(repo);
    expect(task?.version).toBe(2);
    expect(task?.challenged).toEqual(['src/a.ts']);
    expect(task?.forced).toEqual([]);
    expect(task?.overlay).toEqual([]);
  });

  it('treats an unknown version as no task at all', () => {
    fs.mkdirSync(path.join(repo, '.ichor'), { recursive: true });
    fs.writeFileSync(taskPath(repo), JSON.stringify({ version: 99 }), 'utf8');
    expect(loadTask(repo)).toBeUndefined();
  });

  it('treats a corrupt file as no task at all', () => {
    fs.mkdirSync(path.join(repo, '.ichor'), { recursive: true });
    fs.writeFileSync(taskPath(repo), '{ not json', 'utf8');
    expect(loadTask(repo)).toBeUndefined();
  });

  it('clears cleanly', () => {
    saveTask(repo, neighborhood('a', ['x']));
    clearTask(repo);
    expect(loadTask(repo)).toBeUndefined();
  });
});
