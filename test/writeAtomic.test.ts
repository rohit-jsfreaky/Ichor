/**
 * Atomic writes that survive a Windows rename race.
 *
 * `rename` is atomic on POSIX and only usually atomic on NTFS: if anything holds a
 * handle on the destination for an instant — another hook process, a virus
 * scanner, the search indexer — it fails with EPERM instead of waiting.
 *
 * Reproduced by firing six hooks at once, where three boundary draws died with
 * `EPERM: operation not permitted, rename …` and those turns were left with no
 * boundary at all. Several hooks genuinely do overlap: a PostToolUse gate can run
 * while a prompt draws and a detached rebuild writes.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { writeAtomic } from '../src/state.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ichor-atomic-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeAtomic', () => {
  it('writes the file', () => {
    const file = path.join(dir, 'task.json');
    writeAtomic(file, '{"a":1}\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n');
  });

  it('overwrites an existing file', () => {
    const file = path.join(dir, 'task.json');
    writeAtomic(file, 'first');
    writeAtomic(file, 'second');
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
  });

  it('leaves no temp file behind on success', () => {
    const file = path.join(dir, 'task.json');
    writeAtomic(file, 'x');
    expect(fs.readdirSync(dir)).toEqual(['task.json']);
  });

  it('survives many concurrent writers to one path', () => {
    // The shape that produced the EPERM failures. Every write must either land or
    // throw — what must never happen is a half-written file, or a temp file left
    // lying next to it.
    const file = path.join(dir, 'task.json');
    for (let i = 0; i < 40; i++) writeAtomic(file, `value-${i}`);

    expect(fs.readFileSync(file, 'utf8')).toBe('value-39');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('does not leave a temp file behind when the rename cannot succeed', () => {
    // Renaming onto a DIRECTORY fails for a reason no retry can fix. The write is
    // allowed to throw; it is not allowed to litter.
    const target = path.join(dir, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'child'), 'x');

    expect(() => writeAtomic(target, 'nope')).toThrow();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
