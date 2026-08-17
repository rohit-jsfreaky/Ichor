/**
 * The cases a real session hits and nothing else tests.
 *
 *   npm run session:test
 *
 * Every other suite either calls the classifier directly or drives the hook with
 * TypeScript edits inside the demo. Nine bugs were found by running Ichor against
 * real repositories, and NOT ONE of them was caught, because they live in the
 * gaps between those suites:
 *
 *   - a file Ichor cannot read (JSON, CSS, Prisma, config)
 *   - a path that is not in the repository at all
 *   - a prompt that asks a question rather than giving an instruction
 *   - the graph being unreachable or busy when a prompt arrives
 *
 * These drive the REAL compiled hook over REAL payloads, the way an agent does.
 * Cases that document an unfixed bug are marked `knownBug` so the suite reports
 * them without failing the run — they flip to required as each one is fixed.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { analyzeRepo } from '../src/extract/analyze.js';
import { writeGraph } from '../src/graph/write.js';
import { GraphClient, configFromEnv } from '../src/graph/client.js';
import { findAnchors } from '../src/scope/anchors.js';
import { buildNeighborhood } from '../src/scope/neighborhood.js';
import { saveTask, clearTask, loadTask, markJudged, stateDir } from '../src/state.js';
import { unseenEdits } from '../src/hook/stop.js';
import { watchPath } from '../src/hook/prompt.js';

/**
 * Runs against the demo by default and against ANY repository on request:
 *
 *   npm run session:test                       <- demo, fast
 *   npm run session:test -- <repo> "<task>"    <- a real codebase
 *
 * Running it on a real repo is not optional for trusting the result. The two
 * file-type cases below PASS on the demo and FAIL on papermark, because the demo
 * happens to take a different branch — which is the same false confidence that
 * hid all nine bugs in the first place.
 */
const REPO = path.resolve(process.argv[2] ?? './demo');
const CLI = path.resolve('./dist/src/cli.js');
const TASK =
  process.argv[3] ??
  'Duplicate email in vendor onboarding currently returns 500. Handle the duplicate-email case ' +
    'properly, show a toast saying the email already exists, and do not wipe the form.';

/**
 * The task's own words, long enough to be worth matching on.
 *
 * Used to find a real file in this repo whose PATH is about the task, so the case
 * is drawn from the repository rather than invented.
 */
function taskWords(): string[] {
  // Stems, not whole words. The task says "viewers" and the file on disk is
  // `viewer.json`; matching the full word finds nothing, which is the same
  // plural problem the anchor scorer has to solve.
  const words = TASK.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  return [...new Set(words.map((w) => w.slice(0, 5)))].slice(0, 12);
}

/** A file of this type that really exists in the repo, so the case is real. */
function findFile(match: RegExp, skip: RegExp = /node_modules|\.git|\.ichor/): string | undefined {
  const walk = (dir: string, depth: number): string | undefined => {
    if (depth > 4) return undefined;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (skip.test(full)) continue;
      if (entry.isDirectory()) {
        const found = walk(full, depth + 1);
        if (found) return found;
      } else if (match.test(path.relative(REPO, full).split('\\').join('/'))) {
        // Tested against the PATH, not the file name: what makes
        // `locales/en/viewer.json` interesting is the directory it sits in as
        // much as the name.
        return full;
      }
    }
    return undefined;
  };
  return walk(REPO, 0);
}

/**
 * A challenge is a `deny` decision on stdout. The hook ALWAYS exits 0 — it is
 * designed never to fail a turn — so an exit-code check passes every case, which
 * is exactly the false confidence this file exists to remove. It cost two false
 * passes here before it was noticed.
 */
function isChallenged(stdout: string): boolean {
  return /"permissionDecision"\s*:\s*"deny"/.test(stdout);
}

function callHook(payload: unknown, env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; code: number; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, 'hook'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.on('close', (code) => resolve({ stdout, code: code ?? 0, ms: Date.now() - started }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const logPath = () => path.join(stateDir(REPO), 'hook.log');
const readLog = (): string => {
  try {
    return fs.readFileSync(logPath(), 'utf8');
  } catch {
    return '';
  }
};

let passed = 0;
let failed = 0;
let known = 0;

function check(label: string, ok: boolean, detail: string, knownBug?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else if (knownBug) {
    known++;
    console.log(`  ⚠ ${label}  — KNOWN BUG: ${knownBug}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
  if (!ok && detail) console.log(`      ${detail.split('\n').slice(0, 3).join('\n      ')}`);
}

async function main(): Promise<void> {
  // A real, open task for the edit cases to be judged against.
  const facts = analyzeRepo(REPO);
  const client = new GraphClient(configFromEnv());
  let saved;
  try {
    await writeGraph(client, facts);
    const { anchors, terms } = findAnchors(facts, TASK);
    saved = await buildNeighborhood(client, TASK, anchors, terms);
    saveTask(REPO, saved);
  } finally {
    await client.close();
  }
  console.log(`\ntask open — ${saved.stats.memberCount} functions in scope in ${path.basename(REPO)}`);

  // Real files from THIS repo, so the cases are not hypothetical.
  const prismaFile = findFile(/\.prisma$/);
  const jsonFile = findFile(/\.json$/);
  console.log(
    `  probing ${prismaFile ? path.relative(REPO, prismaFile) : '(no .prisma found)'}` +
      ` and ${jsonFile ? path.relative(REPO, jsonFile) : '(no .json found)'}`,
  );

  // ---- files Ichor cannot read -------------------------------------------
  console.log('\n── files Ichor cannot read ─────────────');

  // The schema DECLARES the model this task is about. Editing it is the task.
  {
    saveTask(REPO, saved);
    const result = await callHook({
      tool_name: 'Edit',
      cwd: REPO,
      tool_input: {
        file_path: prismaFile ?? path.join(REPO, 'prisma/schema.prisma'),
        old_string: 'model',
        new_string: 'model /* touched */',
      },
    });
    check(
      'a Prisma schema declaring the task\'s own model is not challenged',
      !isChallenged(result.stdout),
      result.stdout,
      'bug 2 — Ichor reads only .ts/.tsx, so every other file type is absent from the graph and challenged',
    );
  }

  // Ichor has not read this file. It may not claim the edit is scope expansion.
  {
    saveTask(REPO, saved);
    const result = await callHook({
      tool_name: 'Edit',
      cwd: REPO,
      tool_input: {
        file_path: jsonFile ?? path.join(REPO, 'package.json'),
        old_string: '"',
        new_string: '"',
      },
    });
    check(
      'a file Ichor cannot read is reported, never challenged',
      !isChallenged(result.stdout),
      result.stdout,
      'bug 2 — asserting scope expansion about a file it never read',
    );
  }

  // A file Ichor cannot read whose PATH is about the task. This is the case bug 2
  // was found on: `locales/en/viewer.json` during a task about the viewer's
  // expired-link message — the right file, challenged for scope expansion by a
  // tool that had not read a byte of it.
  {
    saveTask(REPO, saved);
    const wordy = findFile(new RegExp(`(${taskWords().join('|')}).*\\.json$`, 'i'));
    if (!wordy) {
      console.log('  – no .json path matching the task in this repo, case skipped');
    } else {
      const before = readLog().length;
      const result = await callHook({
        tool_name: 'Edit',
        cwd: REPO,
        tool_input: { file_path: wordy, old_string: '"', new_string: '"' },
      });
      // CONNECTED, not merely un-challenged. NOT_JUDGED would also be silent, and
      // silence is what this case is meant to distinguish from recognition: Ichor
      // should be able to say why a `viewer.json` belongs to a viewer task.
      const added = readLog().slice(before);
      check(
        `a task-shaped path is recognised, not just tolerated (${path.relative(REPO, wordy)})`,
        !isChallenged(result.stdout) && /-> CONNECTED/.test(added),
        `expected CONNECTED, log said:\n${added.trim() || '(nothing)'}`,
      );
    }
  }

  // ---- restructuring is not editing (bug 5) --------------------------------
  //
  // The two directions of the same edit. Ichor must tell them apart by what OTHER
  // code depends on, not by which file was touched: during a message-wording task
  // an agent pulled `cn` out of `lib/utils.ts` — used in 232 places — and the
  // verdict was CONNECTED and silent.
  //
  // Demo only. A real repo has no file we can safely rewrite and put back.
  if (path.resolve(REPO) === path.resolve('./demo')) {
    console.log('\n── restructuring is not editing ────────');
    const shared = path.join(REPO, 'src/lib/ui/toast.ts');
    const original = fs.readFileSync(shared, 'utf8');

    try {
      // Direction one: the insides change, the surface does not. Ordinary work.
      {
        saveTask(REPO, saved);
        const result = await callHook({
          tool_name: 'Edit',
          cwd: REPO,
          tool_input: {
            file_path: shared,
            old_string: 'const toast: Toast = { kind, message };',
            new_string: 'const toast: Toast = { kind, message: message.trim() };',
          },
        });
        check(
          'rewriting a shared function\'s insides stays silent',
          !isChallenged(result.stdout),
          result.stdout,
        );
      }

      // Direction two: the export is removed. Callers break.
      {
        saveTask(REPO, saved);
        const result = await callHook({
          tool_name: 'Edit',
          cwd: REPO,
          tool_input: {
            file_path: shared,
            old_string: 'export function showToast(',
            new_string: 'function showToast(',
          },
        });
        check(
          'removing an export the rest of the codebase calls is challenged',
          isChallenged(result.stdout) && /showToast/.test(result.stdout),
          `not challenged:\n${result.stdout.slice(0, 400)}`,
        );
      }
    } finally {
      fs.writeFileSync(shared, original);
    }
  }

  // ---- paths outside the repository ---------------------------------------
  console.log('\n── outside the repository ──────────────');
  {
    saveTask(REPO, saved);
    const outside = path.join(os.tmpdir(), 'ichor-not-your-repo.js');
    const result = await callHook({
      tool_name: 'Write',
      cwd: REPO,
      tool_input: { file_path: outside, content: 'console.log(1)\n' },
    });
    const log = readLog();
    check(
      'a path outside the repo is not judged at all',
      !isChallenged(result.stdout) && /outside the repo|not in this repo/i.test(log.slice(-600)),
      `exit ${result.code}; log tail did not say the path was outside the repo`,
      'bug 3 — a scratch file in the system temp directory was classified SUSPICIOUS',
    );
  }

  // ---- a question is not a task -------------------------------------------
  console.log('\n── a question is not a task ────────────');
  {
    clearTask(REPO);
    fs.mkdirSync(stateDir(REPO), { recursive: true });
    fs.writeFileSync(watchPath(REPO), JSON.stringify({ startedAt: new Date().toISOString() }));

    await callHook({
      hook_event_name: 'UserPromptSubmit',
      cwd: REPO,
      prompt_id: 'q-1',
      user_prompt: 'Where is duplicate email handling in this codebase?',
    });
    const after = loadTask(REPO);
    check(
      'asking a question does not open a task',
      after === undefined,
      `a boundary of ${after?.members.length ?? 0} functions was created by a question`,
      'bug 7 — a read-only question set a 374-function boundary on papermark',
    );
  }

  // ---- a rebuild is running when a prompt arrives ---------------------------
  //
  // Bug 6, reproduced on purpose. Finishing a turn that edited files starts a
  // rebuild; prompt again within a few seconds and the boundary draw used to
  // contend with it, blow through the 20-second ceiling, and leave Ichor
  // protecting NOTHING for that turn — visible only in the log.
  //
  // The lock is written directly rather than by racing a real rebuild: the point
  // is what the prompt path does when one is in progress, and a real one would
  // make the test depend on which finished first.
  console.log('\n── a rebuild is running ────────────────');
  {
    clearTask(REPO);
    fs.mkdirSync(stateDir(REPO), { recursive: true });
    fs.writeFileSync(watchPath(REPO), JSON.stringify({ startedAt: new Date().toISOString() }));
    const lock = path.join(stateDir(REPO), 'refresh.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
    const before = readLog().length;

    try {
      const result = await callHook({
        hook_event_name: 'UserPromptSubmit',
        cwd: REPO,
        prompt_id: 'busy-1',
        user_prompt: 'fix the duplicate email crash in vendor onboarding',
      });
      const added = readLog().slice(before);

      check(
        'a prompt during a rebuild returns promptly instead of fighting for the database',
        result.ms < 15_000,
        `took ${result.ms}ms — the old behaviour was to contend until the 20s ceiling`,
      );
      check(
        'and says which it did — waited, or kept the current boundary',
        /waited .* for a rebuild|rebuild is still running/.test(added),
        `the log does not mention the rebuild:\n${added.trim() || '(empty)'}`,
      );
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  // ---- the graph is unreachable when a prompt arrives ----------------------
  //
  // The failure mode this guards against is the worst one seen: the hook wrote
  // its header, took 43 seconds, was killed, and left NO reason in the log — so
  // Ichor was silently inactive for the rest of the session. Whatever happens,
  // a prompt must come back promptly and say what it decided.
  console.log('\n── the graph is unreachable ────────────');
  {
    clearTask(REPO);
    fs.writeFileSync(watchPath(REPO), JSON.stringify({ startedAt: new Date().toISOString() }));
    const before = readLog().length;

    const result = await callHook(
      {
        hook_event_name: 'UserPromptSubmit',
        cwd: REPO,
        prompt_id: 'down-1',
        user_prompt: 'fix the duplicate email crash in vendor onboarding',
      },
      // A port nothing is listening on: the same shape as a database that is
      // busy or down, without having to stop the container.
      { ICHOR_HYDRA_URL: 'bolt://127.0.0.1:59999' },
    );

    const added = readLog().slice(before);
    check(
      'an unreachable graph still returns quickly',
      result.code === 0 && result.ms < 70_000,
      `exit ${result.code} after ${result.ms}ms`,
    );
    check(
      'an unreachable graph leaves a reason in the log',
      /prompt:/.test(added),
      `nothing was logged for this prompt:\n${added.trim() || '(empty)'}`,
    );
  }

  // ---- an edit that never reached the hook -------------------------------
  console.log('\n── an edit written behind the hook (bug 17) ─────────────');

  // One live session modified a file with no hook event at all. That gap cannot
  // be closed from inside a PreToolUse hook — you cannot be called for something
  // that never calls you — so the requirement is that the end of the turn SAYS
  // so, rather than leaving silence to be read as approval.
  {
    saveTask(REPO, saved);
    const scratch = path.join(REPO, 'src', `ichor-session-unseen-${process.pid}.ts`);
    try {
      fs.mkdirSync(path.dirname(scratch), { recursive: true });
      // Written directly, exactly as a shell redirect or a codegen script would.
      fs.writeFileSync(scratch, 'export const writtenWithoutAHook = true;\n');
      const rel = path.relative(REPO, scratch).split(path.sep).join('/');

      const unseen = unseenEdits(REPO, loadTask(REPO)!);
      check(
        'a file written outside an edit tool is reported',
        unseen.includes(rel),
        `unseenEdits returned ${JSON.stringify(unseen)}`,
      );

      // And once it has a verdict it must go quiet, or the line is noise and
      // nobody will read it the one time it matters.
      markJudged(REPO, [rel]);
      const after = unseenEdits(REPO, loadTask(REPO)!);
      check(
        'and stops being reported once it is judged',
        !after.includes(rel),
        `unseenEdits still returned ${JSON.stringify(after)}`,
      );
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  }

  clearTask(REPO);
  console.log(
    `\n${passed} passed, ${failed} failed, ${known} known bugs still open ` +
      `(of ${passed + failed + known})\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

void main();
