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

import { GraphClient, configFromEnv } from './graph/client.js';
import { findAnchors } from './scope/anchors.js';
import { buildNeighborhood } from './scope/neighborhood.js';
import { saveTask, loadTask, clearTask, stateDir, writeAtomic } from './state.js';
import { analyzeAndPersist, refresh } from './refresh/refresh.js';
import { watchPath, isWatching } from './hook/prompt.js';
import { runHook } from './hook/run.js';
import { installHooks } from './hook/install.js';
import { up, down, isRunning } from './stack/stack.js';

const program = new Command();

program
  .name('ichor')
  .description('Make every scope expansion explicit while AI coding agents work.')
  .version('0.1.0');

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

program.parseAsync(process.argv).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
