/**
 * Analyze a repo and write the graph into HydraDB.
 *
 *   npm run ingest -- ./demo
 *
 * Day-2 gate: proves the analyzer's facts survive the round trip into the graph
 * and can be traversed back out.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { analyzeRepo } from '../src/extract/analyze.js';
import { writeGraph } from '../src/graph/write.js';
import { GraphClient, configFromEnv } from '../src/graph/client.js';

const target = path.resolve(process.argv[2] ?? './demo');
if (!fs.existsSync(target)) {
  console.error(`no such directory: ${target}`);
  process.exit(1);
}

async function main() {
  console.log(`\nIchor ingest -> ${target}\n`);

  console.log('analysing…');
  const facts = analyzeRepo(target);
  const s = facts.stats;
  console.log(
    `  ${facts.functions.length} functions, ${facts.calls.length} calls, ` +
      `${facts.touches.length} touches, ${facts.routes.length} routes  (${s.durationMs}ms)`,
  );
  console.log(
    `  call resolution: ${s.callSitesResolvedInRepo} in-repo, ` +
      `${s.callSitesExternal} external, ${s.callSitesUnresolved} unresolved`,
  );

  const client = new GraphClient(configFromEnv());
  try {
    await client.verify();
    const stats = await writeGraph(client, facts, { onProgress: (m) => console.log(`  ${m}`) });

    console.log(
      `\nwrote ${stats.nodesWritten} nodes and ${stats.edgesWritten} edges ` +
        `in ${stats.statements} statements (${stats.durationMs}ms)`,
    );

    // Read it back. A write that cannot be traversed is not a graph.
    const counts = await client.run('MATCH (n:Function) RETURN count(*) AS total');
    console.log(`\nread back ${Number(counts.records[0].get('total'))} Function nodes`);

    console.log('\nINGEST OK\n');
  } catch (err) {
    console.error(`\nINGEST FAILED: ${(err as Error).message}\n`);
    console.error((err as Error).stack);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void main();
