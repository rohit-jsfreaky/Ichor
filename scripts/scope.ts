/**
 * Build a task neighbourhood and print it.
 *
 *   npm run scope -- ./demo "fix duplicate email handling in vendor onboarding"
 *
 * The day-2 gate. Read the output against demo/EXPECTED-GRAPH.md: the vendor
 * submit path should be in, and auth/billing should be out.
 */

import * as path from 'node:path';
import { analyzeRepo } from '../src/extract/analyze.js';
import { findAnchors } from '../src/scope/anchors.js';
import { buildNeighborhood } from '../src/scope/neighborhood.js';
import { GraphClient, configFromEnv } from '../src/graph/client.js';

const repo = path.resolve(process.argv[2] ?? './demo');
const task = process.argv.slice(3).join(' ');

if (!task) {
  console.error('usage: npm run scope -- <repo> "<task>"');
  process.exit(1);
}

async function main() {
  console.log(`\nrepo: ${repo}\ntask: "${task}"\n`);

  const facts = analyzeRepo(repo);
  const { anchors, terms } = findAnchors(facts, task);

  console.log(`terms: ${terms.join(', ')}\n`);

  console.log('── anchors ─────────────────────────────');
  if (anchors.length === 0) console.log('  (none — the task matched nothing in this repo)');
  for (const a of anchors) {
    console.log(`  ${String(a.score).padStart(2)}  ${a.kind.padEnd(9)} ${a.name.padEnd(26)} ${a.why}`);
  }

  const client = new GraphClient(configFromEnv());
  try {
    const hood = await buildNeighborhood(client, task, anchors, terms, {
      onProgress: (m) => console.log(`  ${m}`),
    });

    console.log('\n── neighbourhood ───────────────────────');
    const byDistance = [...hood.members.values()].sort(
      (a, b) => a.distance - b.distance || a.name.localeCompare(b.name),
    );
    for (const m of byDistance) {
      console.log(`  d${m.distance}  ${m.name.padEnd(24)} ${m.file.padEnd(38)} ${m.reason}`);
    }

    console.log('\n── models reached ──────────────────────');
    for (const m of hood.models.values()) console.log(`  ${m.name.padEnd(12)} via ${m.viaFunction}`);

    const s = hood.stats;
    console.log(
      `\n${s.memberCount} functions from ${s.anchorCount} anchors, ` +
        `max depth ${s.maxDistance}, ${s.queryCount} queries, ${s.durationMs}ms`,
    );

    // The two things this fixture must get right.
    console.log('\n── sanity ──────────────────────────────');
    const names = new Set(byDistance.map((m) => m.name));
    const check = (label: string, pass: boolean) => console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    check('createVendor in scope', names.has('createVendor'));
    check('POST handler in scope', names.has('POST'));
    check('submitVendor in scope', names.has('submitVendor'));
    check('createInvoice NOT in scope (billing is unrelated)', !names.has('createInvoice'));
    check('markInvoicePaid NOT in scope', !names.has('markInvoicePaid'));
    console.log('');
  } finally {
    await client.close();
  }
}

void main();
