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
      // neo4j-driver decorates every Result with a captured stack:
      //
      //   function captureStacktrace() { var error = new Error(''); ... }
      //
      // Called from a deep async chain — inside the MCP server's readline
      // iterator, several awaits down — that `new Error('')` throws
      // `RangeError: The value of "offset" is out of range` while V8 builds the
      // async stack. It is purely cosmetic to the driver, so we suppress the
      // capture for the duration of the call and restore it immediately.
      //
      // This does NOT hide our own errors: the RangeError was replacing a real
      // query result with a spurious failure, and our own throws are caught and
      // reported by the caller with their own stacks.
      const previousLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 0;
      try {
        return await session.run(cypher, params);
      } finally {
        Error.stackTraceLimit = previousLimit;
        await session.close();
      }
    });
  }

  /**
   * Retry transport-level failures on a fresh connection.
   *
   * Retries ONLY transport faults, never query errors — a rejected Cypher
   * statement is a bug in our query and must surface immediately rather than be
   * tried again. A broken frame, by contrast, is worth reconnecting for.
   *
   * WHY MORE THAN ONE ATTEMPT: reads intermittently fail with
   * `RangeError: The value of "offset" is out of range`, thrown inside
   * `session.run` while the driver decodes the response. It is a Bolt
   * chunk-framing race between HydraDB's server and the JavaScript driver, so it
   * depends on how the TCP payload happens to be split and recurs at a low rate
   * on identical queries. Verified by logging: the same query succeeds on the
   * next attempt with no change.
   *
   * A single retry left roughly one hook invocation in six silently failing
   * open, which for a tool whose whole job is to challenge an edit is worse than
   * not running at all — you would trust a block that never came.
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 4;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isTransportError(error)) throw error;
        // Drop the poisoned pool; the next attempt rebuilds it.
        await this.close();
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        }
      }
    }
    throw lastError;
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
