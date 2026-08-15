/**
 * Drive the hook the way Claude Code and Codex actually do.
 *
 *   npm run hook:test
 *
 * Spawns the real compiled CLI, writes a real PreToolUse payload to its stdin,
 * and checks the decision on stdout. This is the last thing between "the logic
 * works" and "an agent is actually stopped", so it uses the real process rather
 * than calling runHook() in-process.
 *
 * Requires: an active task (this script creates one) and HydraDB up.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { analyzeRepo } from '../src/extract/analyze.js';
import { writeGraph } from '../src/graph/write.js';
import { GraphClient, configFromEnv } from '../src/graph/client.js';
import { findAnchors } from '../src/scope/anchors.js';
import { buildNeighborhood } from '../src/scope/neighborhood.js';
import { saveTask, clearTask } from '../src/state.js';
import type { Neighborhood } from '../src/scope/neighborhood.js';

const REPO = path.resolve('./demo');
const CLI = path.resolve('./dist/src/cli.js');
const TASK =
  'Duplicate email in vendor onboarding currently returns 500. Handle the duplicate-email case ' +
  'properly, show a toast saying the email already exists, and do not wipe the form.';

const CHECK_EMAIL = `
import { prisma } from '../../../../lib/db';
export async function POST(request: Request) {
  const { email } = await request.json();
  const existing = await prisma.vendor.findUnique({ where: { email } });
  return Response.json({ available: !existing });
}
`;

interface Case {
  label: string;
  payload: unknown;
  expectBlocked: boolean;
}

const CASES: Case[] = [
  {
    label: 'Claude Code · Edit createVendor (legitimate)',
    payload: {
      tool_name: 'Edit',
      cwd: REPO,
      tool_input: {
        file_path: path.join(REPO, 'src/lib/vendors/create.ts'),
        old_string: 'const vendor = await prisma.vendor.create({',
        new_string: 'try {\n    const vendor = await prisma.vendor.create({',
      },
    },
    expectBlocked: false,
  },
  {
    label: 'Claude Code · Write a new /check-email route (over-reach)',
    payload: {
      tool_name: 'Write',
      cwd: REPO,
      tool_input: {
        file_path: path.join(REPO, 'src/app/api/vendors/check-email/route.ts'),
        content: CHECK_EMAIL,
      },
    },
    expectBlocked: true,
  },
  {
    label: 'Claude Code · Edit auth/session.ts (over-reach)',
    payload: {
      tool_name: 'Edit',
      cwd: REPO,
      tool_input: {
        file_path: path.join(REPO, 'src/lib/auth/session.ts'),
        old_string: 'export async function getSession',
        new_string: 'export async function getSession /* tidy */',
      },
    },
    expectBlocked: true,
  },
  {
    label: 'Codex · apply_patch adding /check-email (over-reach)',
    payload: {
      tool_name: 'apply_patch',
      cwd: REPO,
      tool_input: {
        command:
          '*** Begin Patch\n' +
          '*** Add File: src/app/api/vendors/check-email/route.ts\n' +
          CHECK_EMAIL.split('\n').map((l) => `+${l}`).join('\n') +
          '\n*** End Patch\n',
      },
    },
    expectBlocked: true,
  },
  {
    label: 'Codex · apply_patch updating create.ts (legitimate)',
    payload: {
      tool_name: 'apply_patch',
      cwd: REPO,
      tool_input: {
        command:
          '*** Begin Patch\n' +
          '*** Update File: src/lib/vendors/create.ts\n' +
          '@@\n-  const vendor = await prisma.vendor.create({\n+  try {\n',
        },
    },
    expectBlocked: false,
  },
  {
    label: 'Claude Code · Read (not an editing tool, must be ignored)',
    payload: {
      tool_name: 'Read',
      cwd: REPO,
      tool_input: { file_path: path.join(REPO, 'src/lib/auth/session.ts') },
    },
    expectBlocked: false,
  },
];

function callHook(payload: unknown): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    // stderr passes through so ICHOR_DEBUG=1 shows why a case behaved as it did.
    const child = spawn(process.execPath, [CLI, 'hook'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.on('close', (code) => resolve({ stdout, code: code ?? 0 }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

let savedNeighborhood!: Neighborhood;

async function main() {
  // Open a real task so the hook has something to police.
  const facts = analyzeRepo(REPO);
  const client = new GraphClient(configFromEnv());
  try {
    await writeGraph(client, facts);
    const { anchors, terms } = findAnchors(facts, TASK);
    const neighborhood = await buildNeighborhood(client, TASK, anchors, terms);
    savedNeighborhood = neighborhood;
    saveTask(REPO, neighborhood);
    console.log(`\ntask open — ${neighborhood.stats.memberCount} functions in scope\n`);
  } finally {
    await client.close();
  }

  let passed = 0;
  for (const testCase of CASES) {
    // Reset the task before every case. Ichor deliberately challenges a file
    // only ONCE per task, so without this the Codex case would be skipped as
    // already-settled purely because the Claude Code case above it used the
    // same path — and the suite would report a product bug that is not one.
    saveTask(REPO, savedNeighborhood);

    const { stdout, code } = await callHook(testCase.payload);
    const blocked = stdout.includes('"permissionDecision":"deny"') || stdout.includes('"permissionDecision": "deny"');
    const ok = blocked === testCase.expectBlocked && code === 0;
    if (ok) passed++;

    console.log(`${ok ? '✓' : '✗'} ${testCase.label}`);
    console.log(`    ${blocked ? 'BLOCKED' : 'allowed'}${testCase.expectBlocked !== blocked ? `  (expected ${testCase.expectBlocked ? 'BLOCKED' : 'allowed'})` : ''}`);

    if (blocked) {
      const parsed = JSON.parse(stdout) as {
        hookSpecificOutput: { permissionDecisionReason: string };
      };
      const reason = parsed.hookSpecificOutput.permissionDecisionReason;
      for (const line of reason.split('\n').slice(0, 8)) console.log(`    │ ${line}`);
      console.log('    │ …');
    }
    console.log('');
  }

  clearTask(REPO);
  console.log(`${passed}/${CASES.length} hook cases behaved as expected\n`);
  if (passed !== CASES.length) process.exitCode = 1;
}

void main();
