/**
 * Day-1 gate: prove HydraDB is actually usable, not merely listening.
 *
 *   npm run smoke
 *
 * Exercises every primitive Ichor depends on, in the order we depend on them,
 * so a failure points at the exact capability that is missing:
 *
 *   1. connect
 *   2. batched UNWIND write over Bolt      <- how all ingest happens
 *   3. read back
 *   4. bounded variable-length traversal   <- the reachability core
 *   5. algo.SSpaths whole-path retrieval   <- the differentiator query
 *   6. clean up
 *
 * If step 5 fails, Ichor's design changes, so it is better to learn that in the
 * first hour of day 1 than on day 3.
 */

import { GraphClient, configFromEnv, gInt } from '../src/graph/client.js';
import { IdRegistry, nodeKey } from '../src/ids.js';

const LABEL = 'IchorSmoke';

function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`    ${msg}`); }

async function main() {
  const config = configFromEnv();
  console.log(`\nIchor smoke test -> ${config.url}\n`);

  const client = new GraphClient(config);
  const ids = new IdRegistry();

  // A tiny known chain: route -> a -> b -> c -> sink. We know the answers, so
  // any disagreement is the engine or our query, never ambiguity in the data.
  const chain = ['route', 'handler', 'service', 'repo', 'sink'];
  const nodes = chain.map((name, i) => ({
    id: ids.idFor(nodeKey('smoke', 'function', 'smoke.ts', name)),
    name,
    depth: i,
  }));
  // Every id crossing the wire must be a Bolt INTEGER, not a float. See gInt().
  const nodeRows = nodes.map((n) => ({ vertex: gInt(n.id), name: n.name, depth: gInt(n.depth) }));

  try {
    // 1. connect
    await client.verify();
    ok('connected and ran a trivial query');

    // Remove anything a previous failed run left behind.
    await client.run(`MATCH (n:${LABEL}) DETACH DELETE n`);

    // 2. batched write. MERGE by id then SET — HydraDB rejects extra properties
    // inside a MERGE pattern, because the pattern is the identity being matched.
    await client.run(
      `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:${LABEL}, n.name = row.name, n.depth = row.depth`,
      { rows: nodeRows },
    );
    ok(`batched UNWIND write committed (${nodes.length} nodes)`);

    const edges = nodes.slice(0, -1).map((from, i) => ({
      source_vertex: gInt(from.id),
      destination_vertex: gInt(nodes[i + 1].id),
    }));
    await client.run(
      `UNWIND $rows AS row
         MATCH (s:${LABEL} {id: row.source_vertex}), (d:${LABEL} {id: row.destination_vertex})
         CREATE (s)-[:CALLS]->(d)`,
      { rows: edges },
    );
    ok(`batched edge write committed (${edges.length} edges)`);

    // 3. read back
    const count = await client.run(`MATCH (n:${LABEL}) RETURN count(*) AS total`);
    const total = Number(count.records[0].get('total'));
    if (total !== nodes.length) throw new Error(`expected ${nodes.length} nodes, read back ${total}`);
    ok(`read back ${total} nodes`);

    // 4. bounded variable-length traversal. Unbounded (`*`) is rejected by
    // HydraDB by design, so the maximum is always explicit.
    const reach = await client.run(
      `MATCH ({id: $start})-[:CALLS*1..8]->(v:${LABEL}) RETURN v.name AS name ORDER BY name`,
      { start: gInt(nodes[0].id) },
    );
    const reached = reach.records.map((r) => r.get('name'));
    if (reached.length !== 4) throw new Error(`expected 4 reachable, got ${reached.length}: ${reached}`);
    ok(`bounded traversal reached ${reached.length} nodes: ${reached.join(', ')}`);

    // 5. whole paths. Plain MATCH only projects endpoints; the path procedures
    // are the only way to get the chain itself, which is what Ichor reports.
    try {
      const paths = await client.run(
        `CALL algo.SSpaths({sourceNode: $start, relTypes: ['CALLS'], maxLen: 8, pathCount: 1000})
           YIELD path RETURN path`,
        { start: gInt(nodes[0].id) },
      );
      ok(`algo.SSpaths returned ${paths.records.length} paths`);
      info('whole-path retrieval works — the core Ichor query is viable');
    } catch (err) {
      console.log(`  ✗ algo.SSpaths FAILED: ${(err as Error).message}`);
      info('Ichor can fall back to repeated bounded MATCH, but loses the chain.');
      info('Raise this in the Hack Hydra Discord before building on it.');
      throw err;
    }

    // 6. clean up
    await client.run(`MATCH (n:${LABEL}) DETACH DELETE n`);
    ok('cleaned up');

    console.log('\nSMOKE PASSED — HydraDB is writable, traversable and returns whole paths.\n');
  } catch (err) {
    console.error(`\nSMOKE FAILED: ${(err as Error).message}\n`);
    console.error('Checks, in order:');
    console.error('  docker compose ps            all three services up, minio-init exited 0');
    console.error('  docker compose logs hydradb  storage errors show here first');
    console.error('  CLOUD_PROVIDER must be `aws` (S3 protocol) — `local` cannot sustain writes');
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void main();
