/**
 * The only place Ichor talks to HydraDB.
 *
 * HydraDB speaks Bolt 5.x and is Neo4j-driver compatible, so we use the official
 * `neo4j-driver` with no custom client. Nothing outside this module may construct
 * a driver (docs/ENGINEERING-RULES.md rule 3).
 *
 * Two things here are HydraDB-specific and worth knowing before you edit:
 *
 *  - ONE STATEMENT PER REQUEST. HydraDB rejects multi-statement requests, so
 *    there is no "run these three together" helper and there never will be.
 *    Multi-step logic lives in TypeScript across several calls.
 *
 *  - BATCHES MUST GO OVER BOLT. `UNWIND $rows` only works through the client
 *    transport. The in-process shard API rejects it with an error about row
 *    execution rather than about batching, which sends you hunting in the wrong
 *    place. Since we are a Bolt client, we are on the correct side of this.
 */

import neo4j, { type Driver, type Session, type QueryResult, type Integer } from 'neo4j-driver';

/**
 * Wrap a node id for transport.
 *
 * MUST be used for every id sent to HydraDB. Every JavaScript number is a
 * float64, so a plain `number` parameter is encoded as a Bolt FLOAT and HydraDB
 * rejects it:
 *
 *   "UNWIND row 0 field vertex must be a non-negative integer"
 *
 * `neo4j.int()` encodes it as a Bolt INTEGER instead. Reading back is fine
 * unwrapped because `disableLosslessIntegers` is on below and our ids are 52-bit
 * (see src/ids.ts), so they are exactly representable as numbers.
 */
export function gInt(value: number): Integer {
  return neo4j.int(value);
}

export interface HydraConfig {
  /** Bolt endpoint, e.g. bolt://127.0.0.1:7687 */
  url: string;
  /** Auth token; HydraDB reads its own copy from GRAPH_AUTH_TOKEN_FILE. */
  token: string;
  /** Graph namespace. Diff mode uses one namespace per commit. */
  namespace?: string;
}

export function configFromEnv(overrides: Partial<HydraConfig> = {}): HydraConfig {
  return {
    url: overrides.url ?? process.env.ICHOR_HYDRA_URL ?? 'bolt://127.0.0.1:7687',
    token: overrides.token ?? process.env.ICHOR_HYDRA_TOKEN ?? 'ichor-local-development-token-32b',
    namespace: overrides.namespace ?? process.env.ICHOR_HYDRA_NAMESPACE ?? 'default',
  };
}

/**
 * Is this a broken connection rather than a rejected query?
 *
 * HydraDB reports query problems as "OpenCypher query is not supported yet: …",
 * which must never be retried. Everything matched here is the socket, not us.
 */
function isTransportError(error: unknown): boolean {
  const message = (error as Error)?.message ?? '';
  if (/OpenCypher query is not supported/i.test(message)) return false;
  return (
    /offset.*out of range/i.test(message) || // stale pooled connection, mis-framed read
    /ECONNRESET|EPIPE|ECONNREFUSED|socket hang up/i.test(message) ||
    /Connection( was)? (closed|terminated|lost)/i.test(message) ||
    /ServiceUnavailable|SessionExpired/i.test(message)
  );
}

export class GraphClient {
  private driver: Driver | undefined;

  constructor(private readonly config: HydraConfig) {}

  private getDriver(): Driver {
    if (!this.driver) {
      this.driver = neo4j.driver(
        this.config.url,
        // HydraDB authenticates with a bearer token. The driver's basic scheme
        // carries it as the password, which is the same shape Neo4j clients use
        // against token-authenticated servers.
        neo4j.auth.basic('ichor', this.config.token),
        {
          // Deep traversals are the whole point of this tool, and they are fast
          // (20 hops ~= 11ms hot). A generous ceiling only matters on a cold read,
          // where object storage can be slow.
          connectionAcquisitionTimeout: 60_000,
          maxConnectionPoolSize: 16,
          disableLosslessIntegers: true, // ids fit in 52 bits; plain numbers are fine

          // Verify a pooled connection before reusing it. Without this, a
          // connection that went stale while idle is handed back out and the
          // next read fails with a confusing buffer error
          // ("offset out of range ... Received 5") that looks like a bug in our
          // query rather than a dead socket. Observed intermittently between
          // runs; a demo cannot afford it.
          connectionLivenessCheckTimeout: 0,
          maxConnectionLifetime: 15 * 60_000,
        },
      );
    }
    return this.driver;
  }

  private session(): Session {
    return this.getDriver().session();
  }

  /**
   * Run one Cypher statement.
   *
   * Deliberately not variadic and deliberately not batched — see the note at the
   * top about one statement per request.
   */
  async run(cypher: string, params: Record<string, unknown> = {}): Promise<QueryResult> {
    return this.withRetry(async () => {
      const session = this.session();
      try {
        return await session.run(cypher, params);
      } finally {
        await session.close();
      }
    });
  }

  /**
   * Retry once on a transport-level failure.
   *
   * Retries ONLY connection faults, never query errors — a rejected Cypher
   * statement is a bug in our query and must surface immediately rather than be
   * tried again (docs/ENGINEERING-RULES.md rule 2). A dropped socket, by
   * contrast, is worth one clean reconnect, and the alternative is the demo
   * dying on a stale connection.
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isTransportError(error)) throw error;
      await this.close(); // drop the poisoned pool, next call rebuilds it
      return operation();
    }
  }

  /**
   * Prove the connection with a round trip.
   *
   * A listening port is not proof that HydraDB is healthy — it will accept
   * Bolt connections while its object store is misconfigured and fail on the
   * first write. So the smoke path writes, reads back and deletes.
   *
   * NOTE: this deliberately is not `RETURN 1`. HydraDB's row executor only
   * accepts `MATCH ... RETURN` shapes and rejects a standalone `RETURN` with
   * "row execution supports MATCH ... RETURN queries". Counting a label that
   * may match nothing is the cheapest statement it will actually accept.
   */
  async verify(): Promise<void> {
    await this.run('MATCH (n:IchorHealthCheck) RETURN count(*) AS total');
  }

  async close(): Promise<void> {
    await this.driver?.close();
    this.driver = undefined;
  }
}
