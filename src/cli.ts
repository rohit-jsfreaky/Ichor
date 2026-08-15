#!/usr/bin/env node
/**
 * The `ichor` command.
 *
 *   ichor init                install hooks for Claude Code and Codex
 *   ichor start "<task>"      analyse, build the neighbourhood, begin watching
 *   ichor status              what is currently in scope
 *   ichor stop                end the task, stop policing
 *   ichor hook                internal — invoked by the agents' PreToolUse hook
 */

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { analyzeRepo } from './extract/analyze.js';
import { writeGraph } from './graph/write.js';
import { GraphClient, configFromEnv } from './graph/client.js';
import { findAnchors } from './scope/anchors.js';
import { buildNeighborhood } from './scope/neighborhood.js';
import { saveTask, loadTask, clearTask, stateDir } from './state.js';
import { runHook } from './hook/run.js';
import { installHooks } from './hook/install.js';

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

    console.log('\nNext: ichor start "your task"\n');
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

    console.log(`\ntask: "${task}"\n`);

    process.stdout.write('  reading the codebase… ');
    const facts = analyzeRepo(repoRoot);
    console.log(
      `${facts.functions.length} functions, ${facts.calls.length} calls, ${facts.routes.length} routes`,
    );

    const client = new GraphClient(configFromEnv());
    try {
      process.stdout.write('  building the graph… ');
      const written = await writeGraph(client, facts);
      console.log(`${written.nodesWritten} nodes, ${written.edgesWritten} edges`);

      process.stdout.write('  finding the task area… ');
      const { anchors, terms } = findAnchors(facts, task);
      const neighborhood = await buildNeighborhood(client, task, anchors, terms, {
        maxDepth: Number(options.depth),
      });
      console.log(`${neighborhood.stats.memberCount} functions`);

      saveTask(repoRoot, neighborhood);

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
      console.log('\nNo active task. Start one with: ichor start "your task"\n');
      return;
    }

    console.log(`\ntask:    "${task.task}"`);
    console.log(`started: ${task.startedAt}`);
    console.log(`scope:   ${task.members.length} functions`);
    if (task.coreModels.length) console.log(`data:    ${task.coreModels.join(', ')}`);

    if (task.challenged.length) {
      console.log(`\nchallenged (${task.challenged.length}):`);
      for (const file of task.challenged) console.log(`  ⚠ ${file}`);
    }
    if (task.justified.length) {
      console.log(`\nexpanded into (${task.justified.length}):`);
      for (const j of task.justified) console.log(`  ✓ ${j.file} — ${j.reason}`);
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
    console.log(`\nTask closed. ${stateDir(repoRoot)} cleared.\n`);
  });

program
  .command('hook', { hidden: true })
  .description('internal: PreToolUse handler invoked by the agent')
  .action(async () => {
    await runHook();
  });

program.parseAsync(process.argv).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
