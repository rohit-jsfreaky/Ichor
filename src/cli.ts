#!/usr/bin/env node
/**
 * The `ichor` command.
 *
 *   ichor init                install hooks for Claude Code and Codex
 *   ichor up                  start the local HydraDB stack
 *   ichor watch               follow the conversation; the task comes from your prompts
 *   ichor start "<task>"      name the task by hand instead
 *   ichor status              what is currently in scope
 *   ichor stop                end the task, stop policing
 *   ichor down                stop the stack
 *   ichor hook                internal — the agents' hook handler
 *   ichor refresh             internal — the background rebuild between turns
 */

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphClient, configFromEnv } from './graph/client.js';
import { explainFailure } from './errors.js';
import { retrieve } from './retrieval.js';
import { findAnchors } from './scope/anchors.js';
import { buildNeighborhood } from './scope/neighborhood.js';
import { saveTask, loadTask, clearTask, stateDir, writeAtomic } from './state.js';
import { analyzeAndPersist, refresh } from './refresh/refresh.js';
import { watchPath, isWatching } from './hook/prompt.js';
import { runHook } from './hook/run.js';
import {
  clearStoredKey,
  credentialsPath,
  looksLikeOpenRouterKey,
  maskKey,
  readStoredKey,
  readStoredSetAt,
  writeStoredKey,
} from './judge/credentials.js';
import { installHooks } from './hook/install.js';
import { up, down, isRunning } from './stack/stack.js';

/**
 * The version, read from package.json rather than written here twice.
 *
 * It was a literal, and it drifted: package.json said 0.1.1 while `ichor
 * --version` said 0.1.0, so the one number a user can check to tell whether
 * their install has a fix was reporting the version before it. Resolved
 * relative to this file, which lands on the package root both from `dist/src/`
 * in a checkout and from `node_modules/ichor-cli/dist/src/` once installed.
 */
function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    // Never let a missing manifest stop the CLI from running.
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('ichor')
  .description('Make every scope expansion explicit while AI coding agents work.')
  .version(packageVersion());

program
  .command('init')
  .description('install Ichor hooks for Claude Code and Codex in this repo')
  .option('--repo <path>', 'repository root', process.cwd())
  .action((options: { repo: string }) => {
    const repoRoot = path.resolve(options.repo);
    const result = installHooks(repoRoot);

    for (const line of result.messages) console.log(line);

    // Keep Ichor's own state out of the user's commits.
    const gitignore = path.join(repoRoot, '.gitignore');
    if (fs.existsSync(gitignore)) {
      const contents = fs.readFileSync(gitignore, 'utf8');
      if (!contents.includes('.ichor')) {
        fs.appendFileSync(gitignore, `\n# Ichor task state\n.ichor/\n`);
        console.log('  added .ichor/ to .gitignore');
      }
    }

    console.log('\nNext: ichor up      (starts HydraDB)');
    console.log('Then: ichor watch   (Ichor takes the task from your prompts)\n');
  });

program
  .command('watch')
  .description('follow the conversation — the boundary is set from what you ask the agent')
  .option('--repo <path>', 'repository root', process.cwd())
  .action(async (options: { repo: string }) => {
    const repoRoot = path.resolve(options.repo);

    if (!(await isRunning())) {
      console.error('\nHydraDB is not answering on the Bolt port.');
      console.error('Start it with: ichor up\n');
      process.exitCode = 1;
      return;
    }

    const client = new GraphClient(configFromEnv());
    try {
      process.stdout.write('\n  reading the codebase… ');
      const facts = await analyzeAndPersist(repoRoot, client);
      console.log(
        `${facts.functions.length} functions, ${facts.calls.length} calls, ${facts.routes.length} routes`,
      );

      // No task yet, on purpose. The first thing you ask the agent decides what
      // this task is; guessing one now would just be a boundary nobody chose.
      clearTask(repoRoot);
      writeAtomic(
        watchPath(repoRoot),
        `${JSON.stringify({ version: 1, startedAt: new Date().toISOString(), repoRoot }, null, 2)}\n`,
      );

      console.log('\nWatching. Run your agent as usual — Ichor picks the task up from your prompts.');
      console.log('Check what it decided any time with: ichor status\n');
    } finally {
      await client.close();
    }
  });

program
  .command('refresh', { hidden: true })
  .description('internal: rebuild the graph in the background after a turn')
  .option('--repo <path>', 'repository root', process.cwd())
  .option('--force', 'rebuild even if nothing looks stale', false)
  .action(async (options: { repo: string; force: boolean }) => {
    const result = await refresh(path.resolve(options.repo), { force: options.force });
    if (process.env.ICHOR_DEBUG === '1') console.error(`[ichor refresh] ${result.why}`);
  });

program
  .command('up')
  .description('start the local HydraDB stack')
  .option('--repo <path>', 'repository root', process.cwd())
  .action(async (options: { repo: string }) => {
    const code = await up(path.resolve(options.repo));
    if (code !== 0) process.exitCode = code;
  });

program
  .command('down')
  .description('stop the local HydraDB stack')
  .option('--repo <path>', 'repository root', process.cwd())
  .option('--wipe', 'also delete the stored graph', false)
  .action(async (options: { repo: string; wipe: boolean }) => {
    const code = await down(path.resolve(options.repo), options.wipe);
    if (code !== 0) process.exitCode = code;
  });

program
  .command('start')
  .argument('<task...>', 'what you asked the agent to do')
  .description('analyse the repo and open a task boundary')
  .option('--repo <path>', 'repository root', process.cwd())
  .option('--depth <n>', 'how far to expand from an anchor', '3')
  .action(async (taskWords: string[], options: { repo: string; depth: string }) => {
    const repoRoot = path.resolve(options.repo);
    const task = taskWords.join(' ');

    // Analysing first and failing at the graph write wastes the slowest step and
    // reports it as a driver error. Check the database is there while it is
    // still cheap to say so plainly.
    if (!(await isRunning())) {
      console.error('\nHydraDB is not answering on the Bolt port.');
      console.error('Start it with: ichor up\n');
      process.exitCode = 1;
      return;
    }

    console.log(`\ntask: "${task}"\n`);

    const client = new GraphClient(configFromEnv());
    try {
      process.stdout.write('  reading the codebase… ');
      // Same path as `watch`: it also caches the facts and the name index, so an
      // explicitly-started task still notices when you move on to another job.
      const facts = await analyzeAndPersist(repoRoot, client);
      console.log(
        `${facts.functions.length} functions, ${facts.calls.length} calls, ${facts.routes.length} routes`,
      );

      process.stdout.write('  finding the task area… ');
      const { anchors, terms } = findAnchors(facts, task);
      const neighborhood = await buildNeighborhood(client, task, anchors, terms, {
        maxDepth: Number(options.depth),
      });
      console.log(`${neighborhood.stats.memberCount} functions`);
      if (neighborhood.stats.truncated) {
        console.log('  ⚠ hit the member cap — the task area is unusually large, and edits');
        console.log('    just outside the boundary may be questioned.');
      }

      // Explicit beats inferred: naming a task by hand also stops prompt-driven
      // detection from redrawing it out from under you.
      saveTask(repoRoot, neighborhood, { mode: 'explicit' });
      if (fs.existsSync(watchPath(repoRoot))) fs.rmSync(watchPath(repoRoot));

      console.log('\nIn scope:');
      const sorted = [...neighborhood.members.values()].sort((a, b) => a.distance - b.distance);
      for (const m of sorted.slice(0, 10)) {
        console.log(`  ${m.name.padEnd(24)} ${m.file}`);
      }
      if (sorted.length > 10) console.log(`  … and ${sorted.length - 10} more`);

      if (neighborhood.coreModels.size) {
        console.log(`\nData this task is about: ${[...neighborhood.coreModels].join(', ')}`);
      }

      if (anchors.length === 0) {
        console.log(
          '\n⚠ Nothing in the repo matched this task. Ichor will stay silent rather than guess.',
        );
      }

      console.log('\nWatching. Run your agent as usual.\n');
    } finally {
      await client.close();
    }
  });

program
  .command('status')
  .description('show the active task boundary')
  .option('--repo <path>', 'repository root', process.cwd())
  .action((options: { repo: string }) => {
    const repoRoot = path.resolve(options.repo);
    const task = loadTask(repoRoot);

    if (!task) {
      if (isWatching(repoRoot)) {
        console.log('\nWatching this repo. No task yet — it is set by what you ask the agent next.\n');
        return;
      }
      console.log('\nNo active task. Start one with: ichor watch, or: ichor start "your task"\n');
      return;
    }

    console.log(`\ntask:    "${task.task}"`);
    console.log(`set by:  ${task.mode === 'watch' ? 'your prompt' : 'ichor start'}`);
    console.log(`started: ${task.startedAt}`);
    console.log(`scope:   ${task.members.length} functions`);
    if (task.coreModels.length) console.log(`data:    ${task.coreModels.join(', ')}`);
    if (task.graphBuiltAt) console.log(`graph:   built ${task.graphBuiltAt}`);

    if (task.challenged.length) {
      console.log(`\nchallenged (${task.challenged.length}):`);
      for (const file of task.challenged) console.log(`  ⚠ ${file}`);
    }
    if (task.justified.length) {
      console.log(`\nexpanded into (${task.justified.length}):`);
      for (const j of task.justified) console.log(`  ✓ ${j.file} — ${j.reason}`);
    }
    if (task.forced.length) {
      // Shown separately from `challenged` because the distinction matters: the
      // agent answered these by writing them again rather than by explaining.
      console.log(`\nchallenged, then written anyway (${task.forced.length}):`);
      for (const f of task.forced) console.log(`  ⚠ ${f.file}`);
      console.log('  never justified — Ichor will not cite these as existing paths');
    }
    console.log('');
  });

program
  .command('stop')
  .description('end the active task')
  .option('--repo <path>', 'repository root', process.cwd())
  .action((options: { repo: string }) => {
    const repoRoot = path.resolve(options.repo);
    clearTask(repoRoot);
    if (fs.existsSync(watchPath(repoRoot))) fs.rmSync(watchPath(repoRoot));
    console.log(`\nTask closed, and no longer watching. Re-arm with: ichor watch\n`);
  });

/**
 * Store an OpenRouter key so the Judge can be used.
 *
 * Ichor works fully without one, and this command exists so that trying the part
 * that needs a key is one line rather than a shell-export ritual repeated in every
 * terminal that might launch an agent. The alternative people reach for — pasting a
 * key into a file inside the repo — is one `git add -A` from being published.
 *
 * The key is written to the HOME directory, never here. See judge/credentials.ts.
 */
program
  .command('key [value]')
  .description('store your own OpenRouter key, so the Judge can weigh an argument')
  .option('--remove', 'delete the stored key')
  .option('--no-check', 'skip asking OpenRouter whether the key works')
  .action(async (value: string | undefined, options: { remove?: boolean; check?: boolean }) => {
    if (options.remove) {
      console.log(
        clearStoredKey()
          ? `\nStored key removed. Ichor still works — an argument alone will no longer grant an expansion.\n`
          : `\nThere was no stored key to remove.\n`,
      );
      return;
    }

    // No argument: report, never print the key.
    if (!value) {
      const fromEnv =
        process.env.ICHOR_OPENROUTER_KEY ??
        process.env.OPENROUTER_API_KEY ??
        process.env.OPENROUTER_KEY;
      const stored = readStoredKey();

      console.log('');
      if (fromEnv) {
        console.log(`  key   ${maskKey(fromEnv)}   from the environment`);
        if (stored) console.log(`        (a stored key exists too; the environment wins)`);
      } else if (stored) {
        const setAt = readStoredSetAt();
        console.log(`  key   ${maskKey(stored)}   ${credentialsPath()}`);
        if (setAt) console.log(`        set ${setAt}`);
      } else {
        console.log('  key   not set');
        console.log('');
        console.log('  Ichor works without one. Every boundary, every challenge and every');
        console.log('  retrieval tool needs no key — what a key adds is the ability to WEIGH an');
        console.log("  agent's argument that an expansion is necessary. Without it, an argument");
        console.log('  Ichor cannot verify comes to you instead of being granted.');
        console.log('');
        console.log('  Set one:  ichor key sk-or-…        (from https://openrouter.ai/keys)');
      }
      console.log('');
      return;
    }

    const shape = looksLikeOpenRouterKey(value);
    if (!shape.ok) {
      console.log(`\n  That does not look like an OpenRouter key — ${shape.why}\n`);
      process.exitCode = 1;
      return;
    }

    /**
     * Ask OpenRouter whether the key works, before storing it.
     *
     * A key that is wrong by one character fails silently later: the Judge degrades
     * to the graph-only verdict, which is exactly what a MISSING key does, so there
     * is nothing to notice. One request now turns that into an answer.
     */
    if (options.check !== false) {
      process.stdout.write('\n  checking the key with OpenRouter… ');
      const ok = await checkKey(value);
      if (ok === false) {
        console.log('rejected.\n\n  OpenRouter did not accept that key. Nothing was stored.\n');
        process.exitCode = 1;
        return;
      }
      console.log(ok === true ? 'accepted.' : 'could not reach OpenRouter — storing it anyway.');
    }

    const file = writeStoredKey(value);
    console.log(`\n  Stored ${maskKey(value)} in ${file}`);
    console.log('  Readable only by you, and outside every repository so it cannot be committed.');
    console.log('\n  The Judge is now available. It is consulted only when an agent argues that an');
    console.log('  expansion is necessary — never on an ordinary edit — and is capped per task');
    console.log('  and per file, so a long session cannot run away with your credit.\n');
  });

/**
 * Does OpenRouter accept this key?
 *
 * `true` accepted, `false` rejected, `undefined` we could not tell — which is
 * treated as "store it" rather than "refuse", because a developer offline on a
 * train has still given us the right key.
 */
async function checkKey(key: string): Promise<boolean | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.status === 401 || response.status === 403) return false;
    return response.ok ? true : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Retrieval from a shell, not only over MCP.
 *
 * These are the same three questions the MCP tools answer, reachable as commands
 * because that is the door the agent is currently told to use. See
 * src/retrieval.ts for the measurement behind that.
 *
 * Deliberately NOT hidden: a person debugging their own repo wants these too, and
 * a tool an agent is told about but a human cannot run is hard to trust.
 */
const retrievalRepo = (options: { repo: string }) => path.resolve(options.repo);

async function runRetrieval(
  command: Parameters<typeof retrieve>[0],
  args: Record<string, unknown>,
  options: { repo: string },
): Promise<void> {
  try {
    console.log(await retrieve(command, args, retrievalRepo(options)));
  } catch (error) {
    // A retrieval failure is not a crash: say what went wrong and exit non-zero.
    for (const line of explainFailure(error)) console.error(line);
    process.exitCode = 1;
  }
}

program
  .command('find')
  .description('where something lives, described in plain words instead of a grep pattern')
  .argument('<words...>', 'plain description, e.g. "where uploads are retried"')
  .option('--repo <path>', 'repository root', process.cwd())
  .option('--limit <n>', 'how many results', '15')
  .action(async (words: string[], options: { repo: string; limit: string }) => {
    await runRetrieval('find', { query: words.join(' '), limit: Number(options.limit) || 15 }, options);
  });

program
  .command('impact')
  .description('what else is affected if this function or type changes')
  .argument('<symbol>', 'exact function or type name')
  .option('--repo <path>', 'repository root', process.cwd())
  .action(async (symbol: string, options: { repo: string }) => {
    await runRetrieval('impact', { symbol }, options);
  });

program
  .command('paths')
  .description('how the app reaches a database table, and through which endpoints')
  .argument('<model>', 'model or table name, e.g. Vendor')
  .option('--repo <path>', 'repository root', process.cwd())
  .option('--route <url>', 'only paths whose URL contains this')
  .action(async (model: string, options: { repo: string; route?: string }) => {
    await runRetrieval('paths', { model, ...(options.route ? { route: options.route } : {}) }, options);
  });

program
  .command('callers')
  .description('what calls this function')
  .argument('<symbol>', 'exact function name')
  .option('--repo <path>', 'repository root', process.cwd())
  .action(async (symbol: string, options: { repo: string }) => {
    await runRetrieval('callers', { symbol }, options);
  });

program
  .command('check')
  .description('is a file part of the current task, and why')
  .argument('<file>', 'path relative to the repository root')
  .option('--repo <path>', 'repository root', process.cwd())
  .action(async (file: string, options: { repo: string }) => {
    await runRetrieval('check', { file }, options);
  });

program
  .command('hook', { hidden: true })
  .description('internal: PreToolUse handler invoked by the agent')
  .action(async () => {
    await runHook();
  });

program
  .command('mcp', { hidden: true })
  .description('internal: MCP server over stdio, so the agent can ask why and argue back')
  .option('--repo <path>', 'repository root', process.cwd())
  .action(async (options: { repo: string }) => {
    const { runMcpServer } = await import('./mcp/server.js');
    await runMcpServer(path.resolve(options.repo));
  });

/**
 * The one place an unhandled failure reaches a person.
 *
 * Printing `error.message` was fine for errors this codebase throws and useless
 * for everything else, which is most of what lands here. See src/errors.ts.
 */
program.parseAsync(process.argv).catch((error: unknown) => {
  for (const line of explainFailure(error)) console.error(line);
  if (process.env.ICHOR_DEBUG === '1') console.error(error);
  process.exit(1);
});
