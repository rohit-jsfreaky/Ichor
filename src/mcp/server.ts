/**
 * Ichor's MCP server — the collaboration layer.
 *
 * The hook is the ENFORCEMENT layer: it fires whether the agent likes it or not,
 * so Ichor cannot be forgotten. This is the other half — it lets the agent ask
 * why something was flagged, argue its case, and request that the boundary grow.
 *
 * Without it Ichor is a wall. With it, Ichor is a senior engineer asking "why?"
 * and able to be persuaded by evidence.
 *
 * Deliberately NOT the enforcement path. An agent can simply choose not to call
 * an MCP tool, so nothing here is trusted to keep scope honest — the hook does
 * that. These tools only make the conversation possible.
 *
 * Speaks MCP over stdio using JSON-RPC 2.0 directly. No SDK: the surface is seven
 * tools and adding a dependency for that would be the larger risk.
 */

import * as readline from 'node:readline';
import { GraphClient, configFromEnv } from '../graph/client.js';
import { callersOf, functionsTouching, impactOf, pathsToModel } from '../graph/queries.js';
import { loadFacts } from '../refresh/refresh.js';
import { findAnchors } from '../scope/anchors.js';
import { repoIdFor, IdRegistry } from '../ids.js';
import { loadTask, toNeighborhood, markJustified, type PersistedTask } from '../state.js';
import { classify, isChallenge } from '../scope/classify.js';
import { parsePending } from '../scope/pending.js';
import { askJudge, formatOpinion } from '../judge/judge.js';
import { packageVersion } from '../version.js';
import { checkBudget, recordJudgeCall } from '../judge/budget.js';

const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Tool descriptions are written for the agent, not for a human reading docs.
 * They state when to call the tool, because an agent that does not know when to
 * ask will simply never ask.
 */
const TOOLS: ToolDefinition[] = [
  {
    name: 'ichor_task_status',
    description:
      'What task Ichor is currently tracking and how big its scope is. Call this at the start of a ' +
      'session to know whether a task boundary is active.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ichor_get_scope',
    description:
      'List the functions and files currently considered part of the task, with the reason each is ' +
      'included. Call this BEFORE making a change if you are unsure whether a file is in scope.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'optional: only entries in this file' } },
    },
  },
  {
    name: 'ichor_check_change',
    description:
      'Ask whether a change belongs to the task before you make it. Returns EXPECTED, CONNECTED, ' +
      'SUSPICIOUS or HUMAN_REVIEW with the graph evidence behind it. Cheaper than being blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'repo-relative path' },
        content: { type: 'string', description: 'proposed content, required for a new file' },
        operation: { type: 'string', enum: ['edit', 'create', 'delete'] },
      },
      required: ['file'],
    },
  },
  {
    name: 'ichor_explain',
    description:
      'Explain why a specific file was flagged, showing the path from the task to it — or the ' +
      'absence of one. Call this when Ichor blocks you and you want the reasoning.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'repo-relative path' } },
      required: ['file'],
    },
  },
  {
    name: 'ichor_request_scope_expansion',
    description:
      'Argue that a file outside the task is genuinely required, and why. Ichor checks the ' +
      'explanation against the codebase rather than taking it on trust — a convincing reason with ' +
      'no structural support is still refused, and ambiguous cases go to the developer.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'repo-relative path' },
        reason: { type: 'string', description: 'why this change is required BY THE TASK' },
      },
      required: ['file', 'reason'],
    },
  },
  // The two below are not about policing at all. They exist because an agent
  // that can ask the graph a structural question stops grepping for a name and
  // opening every file that matches, which is where most of a session's tokens
  // go. Descriptions are written to tell the agent WHEN to reach for them.
  {
    name: 'ichor_callers',
    description:
      'Who calls this function, directly or through a chain, and which HTTP endpoints reach it. ' +
      'Use this before changing or deleting a function instead of searching the repo for its name — ' +
      'the answer comes from the compiler, so it includes callers a text search would miss and ' +
      'excludes matches in comments and strings.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'exact function name' } },
      required: ['symbol'],
    },
  },
  {
    name: 'ichor_find',
    description:
      'Where does something live in this codebase? Describe it in plain words — "the place ' +
      'invites are created", "duplicate email handling" — and get the functions, types, routes ' +
      'and tables that match, ranked, with file paths. Use this INSTEAD of grepping for a guessed ' +
      'name: it searches the compiled structure rather than text, so it skips matches in comments ' +
      'and strings. It matches NAMES rather than meaning — use the words your codebase uses.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'plain description of what you are looking for' },
        limit: { type: 'number', description: 'how many results (default 15)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ichor_impact',
    description:
      'What else is affected if I change this? Returns who calls it, which HTTP endpoints end up ' +
      'running it, which database tables are at stake, and — for a type — which functions depend ' +
      'on its shape. Use this BEFORE editing or deleting anything whose blast radius you are not ' +
      'certain of.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'exact function or type name' } },
      required: ['symbol'],
    },
  },
  {
    name: 'ichor_paths',
    description:
      'How the application reaches a database table: which endpoints, through which functions. ' +
      'Use this when you need to know whether a way to read or write some data already exists, ' +
      'before adding a new one. No file search can answer this.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'model/table name, e.g. Vendor' },
        route: { type: 'string', description: 'optional: only paths whose URL contains this' },
      },
      required: ['model'],
    },
  },
];

function ok(result: unknown, id: JsonRpcRequest['id']) {
  return { jsonrpc: '2.0' as const, id, result };
}

function fail(message: string, id: JsonRpcRequest['id'], code = -32603) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

/** MCP tool results are content blocks; everything we return is text. */
function text(body: string) {
  return { content: [{ type: 'text', text: body }] };
}

export async function runMcpServer(repoRoot: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  /**
   * ONE client for the life of the server.
   *
   * Creating and closing a driver per tool call is wasteful — pooling is the
   * whole point of the driver — and empirically the second driver in a process
   * fails with a mis-framed read ("offset is out of range"). One long-lived
   * client is both the correct design and the fix.
   */
  let graph: GraphClient | undefined;
  const getGraph = (): GraphClient => (graph ??= new GraphClient(configFromEnv()));

  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

  const requireTask = (): PersistedTask => {
    const task = loadTask(repoRoot);
    if (!task) throw new Error('No active Ichor task. The developer starts one with: ichor start "<task>"');
    return task;
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      continue; // not our message; stay quiet rather than poison the stream
    }

    try {
      switch (request.method) {
        case 'initialize':
          send(
            ok(
              {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'ichor', version: packageVersion() },
              },
              request.id,
            ),
          );
          break;

        case 'notifications/initialized':
          break; // notification: no reply

        case 'tools/list':
          send(ok({ tools: TOOLS }, request.id));
          break;

        case 'tools/call': {
          const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const body = await callTool(String(params.name), params.arguments ?? {}, repoRoot, requireTask, getGraph);
          send(ok(text(body), request.id));
          break;
        }

        case 'ping':
          send(ok({}, request.id));
          break;

        default:
          if (request.id !== undefined) send(fail(`unknown method: ${request.method}`, request.id, -32601));
      }
    } catch (error) {
      // stderr never carries protocol traffic, so a stack here is safe and is the
      // only way to debug a tool failure from inside an agent session.
      process.stderr.write(`[ichor mcp] ${request.method} failed: ${(error as Error).stack ?? error}\n`);
      if (request.id !== undefined) send(fail((error as Error).message, request.id));
    }
  }
}

/**
 * How long a retrieval tool may take before the agent is told to use its own search.
 *
 * WHY THIS EXISTS
 *
 * A tool that FAILS is recovered from instantly — the agent shrugs and greps. A tool
 * that is merely SLOW blocks, and there is no signal to fall back on. One real session
 * spent about 38 seconds inside a single `ichor_impact` call before answering, and the
 * developer's reaction was the correct one: this cannot be the cost of asking.
 *
 * That 38 seconds was never explained. Two candidate causes were measured and both
 * disproved — database size (4,019 Function nodes across 10 projects answers the same
 * query in 575ms) and contention with a background rebuild (589ms idle versus 572ms
 * mid-rebuild). Its normal cost is 150–600ms.
 *
 * So this is deliberately NOT a fix for a known cause. It is a bound, which is the
 * right shape of answer when the cause is unknown: whatever that was, it can no longer
 * cost an agent more than a second and a half, because at that point Ichor stops
 * answering and says so. An unbounded unknown becomes a bounded, honest failure.
 *
 * Only the retrieval tools get a budget. The scope tools read local JSON and cannot be
 * slow, and `ichor_request_scope_expansion` deliberately waits on the Judge.
 */
function retrievalBudgetMs(): number {
  // Overridable so the MCP suite can force the fallback deterministically, and so a
  // slow machine or a very large graph can be given more rope without a rebuild.
  const raw = Number(process.env.ICHOR_RETRIEVAL_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_500;
}

const NEEDS_BUDGET = new Set(['ichor_find', 'ichor_impact', 'ichor_callers', 'ichor_paths']);

/**
 * Answer, or hand the question back — never make the agent wait.
 *
 * The pending query is not cancelled, because Bolt gives no way to cancel one. It is
 * abandoned: it finishes into nothing while the agent gets on with its own search. That
 * wastes a little database work and costs the agent no time, which is the right trade
 * for a tool whose entire value proposition is being faster than a grep.
 */
async function withinBudget(name: string, work: Promise<string>): Promise<string> {
  const budget = retrievalBudgetMs();
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<string>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          `${name} did not answer within ${budget}ms, so it has nothing for you ` +
            'on this one. Use your own search tools instead — Grep and reading files will ' +
            'answer this, and waiting on Ichor here would cost you more than it saves. ' +
            'Nothing is wrong with the code you are asking about; only this lookup was slow.',
        ),
      budget,
    );
    timer.unref?.();
  });

  const started = Date.now();
  try {
    return await Promise.race([work, giveUp]);
  } finally {
    if (timer) clearTimeout(timer);
    const ms = Date.now() - started;
    // Recorded on every call, not only slow ones, so an unexplained 38 seconds is
    // diagnosable the next time it happens instead of being lost.
    if (ms > budget / 3) {
      process.stderr.write(`[ichor mcp] ${name} took ${ms}ms
`);
    }
  }
}

/**
 * Where a named function lives, answered from disk rather than from the database.
 *
 * The graph is queried by node id everywhere else, and an id lookup costs the same
 * however much else is loaded. Finding the STARTING node was the exception: it matched
 * on name and repo, and with no property index that is a scan of every Function node in
 * the database — including every other project's.
 *
 * `facts.json` already holds every function with its key, and ids are derived from keys
 * deterministically, so the starting id is computable locally. Measured at 7ms against
 * 32ms for the scan, and unlike the scan it does not get slower as the database fills.
 *
 * Returns undefined when there are no cached facts, in which case the query falls back
 * to the scan rather than pretending the symbol does not exist.
 */
function seedIdsFor(repoRoot: string, symbol: string): number[] | undefined {
  const facts = loadFacts(repoRoot);
  if (!facts) return undefined;
  const ids = new IdRegistry();
  const matched = facts.functions.filter((fn) => fn.name === symbol).map((fn) => ids.idFor(fn.key));
  // No match locally is not proof of absence — the facts may be a rebuild behind — so
  // this hands back to the scan rather than asserting nothing is there.
  return matched.length > 0 ? matched : undefined;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  repoRoot: string,
  requireTask: () => PersistedTask,
  getGraph: () => GraphClient,
): Promise<string> {
  if (NEEDS_BUDGET.has(name)) {
    return withinBudget(name, runTool(name, args, repoRoot, requireTask, getGraph));
  }
  return runTool(name, args, repoRoot, requireTask, getGraph);
}

/**
 * Dispatch one tool call.
 *
 * Exported because the CLI reaches retrieval through this same function (see
 * src/retrieval.ts). Two implementations of the same question would drift, and a
 * shell answer that disagrees with the MCP answer is worse than either alone.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  repoRoot: string,
  requireTask: () => PersistedTask,
  getGraph: () => GraphClient,
): Promise<string> {
  switch (name) {
    case 'ichor_task_status': {
      const task = loadTask(repoRoot);
      if (!task) return 'No active task. Ichor is not tracking scope right now.';
      return [
        `Task: ${task.task}`,
        `Started: ${task.startedAt}`,
        `In scope: ${task.members.length} functions`,
        task.coreModels.length ? `Data the task is about: ${task.coreModels.join(', ')}` : '',
        task.challenged.length ? `Challenged so far: ${task.challenged.join(', ')}` : '',
        task.justified.length ? `Expanded into: ${task.justified.map((j) => j.file).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'ichor_get_scope': {
      const task = requireTask();
      const filter = typeof args.file === 'string' ? args.file : undefined;
      const members = task.members
        .filter((m) => !filter || m.file === filter)
        .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));

      if (members.length === 0) {
        return filter
          ? `Nothing in ${filter} is part of the task. Editing it would be treated as scope expansion.`
          : 'The task boundary is empty.';
      }

      const lines = members.map((m) => `  d${m.distance}  ${m.name}  (${m.file})  — ${m.reason}`);
      return [`Task: ${task.task}`, '', 'In scope:', ...lines].join('\n');
    }

    case 'ichor_check_change': {
      const task = requireTask();
      const file = String(args.file ?? '');
      if (!file) throw new Error('file is required');

      const content = typeof args.content === 'string' ? args.content : undefined;
      const operation = (args.operation as 'edit' | 'create' | 'delete') ?? (content ? 'create' : 'edit');

      const client = new GraphClient(configFromEnv());
      try {
        const verdict = await classify(
          { operation, file, content },
          {
            repo: repoIdFor(repoRoot),
            client,
            neighborhood: toNeighborhood(task),
            pending: content ? parsePending(file, content) : undefined,
            forced: task.forced.map((f) => f.file),
          },
        );

        const lines = [`${verdict.decision}: ${verdict.reason}`];
        if (verdict.evidence.length) {
          lines.push('', 'Evidence:');
          for (const e of verdict.evidence) lines.push(`  · ${e.text}`);
        }
        if (verdict.question) lines.push('', verdict.question);
        if (isChallenge(verdict)) {
          /**
           * Name the door that is open.
           *
           * This said "call ichor_request_scope_expansion" — advice a reader coming
           * from a shell cannot act on, and advice the AGENT cannot act on either
           * until the workspace is trusted, which is the default for a fresh clone.
           * The hook's challenge text was corrected for that; these verdicts were
           * missed. Both routes are named now, shell first, because it is the one
           * that always works.
           */
          lines.push(
            '',
            `If this is genuinely required, say why and have it weighed against the graph:`,
            `  ichor justify ${file} "<why the task needs it>"`,
            '(or the ichor_request_scope_expansion tool, where MCP tools are permitted)',
          );
        }
        return lines.join('\n');
      } finally {
        await client.close();
      }
    }

    case 'ichor_explain': {
      const task = requireTask();
      const file = String(args.file ?? '');
      const inFile = task.members.filter((m) => m.file === file);

      if (inFile.length === 0) {
        return [
          `Nothing in ${file} is reachable from this task.`,
          '',
          `Task: ${task.task}`,
          `The task works on: ${task.coreModels.join(', ') || '(no models)'}`,
          '',
          'That is why an edit here is treated as scope expansion. If the task genuinely requires it,',
          `say why: ichor justify ${file} "<why the task needs it>"`,
          '(or the ichor_request_scope_expansion tool, where MCP tools are permitted)',
        ].join('\n');
      }

      const lines = inFile
        .sort((a, b) => a.distance - b.distance)
        .map((m) => `  ${m.name} — distance ${m.distance} from the task, because it ${m.reason}`);
      return [`${file} is connected to the task:`, ...lines].join('\n');
    }

    case 'ichor_request_scope_expansion': {
      const task = requireTask();
      const file = String(args.file ?? '');
      const reason = String(args.reason ?? '');
      if (!file || !reason) throw new Error('file and reason are both required');

      // The agent's confidence is not evidence. Check the claim against the graph
      // before letting the boundary grow.
      const verdict = await classify(
        { operation: 'edit', file },
        { client: getGraph(), neighborhood: toNeighborhood(task), repo: repoIdFor(repoRoot), forced: task.forced.map((f) => f.file) },
      );

      // GRAPH FIRST. If the structure already supports it, no model is needed.
      if (verdict.decision === 'EXPECTED' || verdict.decision === 'CONNECTED') {
        markJustified(repoRoot, file, reason);
        return [
          `Granted. ${file} is now part of the task boundary.`,
          `Ichor found supporting structure: ${verdict.reason}`,
        ].join('\n');
      }

      // LLM SECOND, and only here — this is the one place the agent has actually
      // made an argument, so it is the only place an argument can be weighed.
      // The hook deliberately does not call the Judge: it must stay fast, and
      // pre-edit there is no argument to weigh yet.
      const budget = checkBudget(repoRoot, file);
      const neighborhood = toNeighborhood(task);

      if (budget.allowed) {
        const opinion = await askJudge({ neighborhood, verdict, file, agentReason: reason });
        if (opinion) {
          recordJudgeCall(repoRoot, file);

          if (opinion.decision === 'SUPPORTED_EXPANSION' || opinion.decision === 'EXPECTED') {
            markJustified(repoRoot, file, reason);
            return [
              `Granted. ${file} is now part of the task boundary.`,
              '',
              formatOpinion(opinion),
            ].join('\n');
          }

          if (opinion.decision === 'HUMAN_DECISION') {
            return [
              `This is the developer's call, not Ichor's.`,
              '',
              formatOpinion(opinion),
              '',
              'Ask the developer before expanding the task, or take the smaller change that stays on',
              'the existing path.',
            ].join('\n');
          }

          return [`Not granted. ${verdict.reason}`, '', formatOpinion(opinion)].join('\n');
        }
      }

      // No Judge — no key, unreachable, or out of budget. The graph verdict
      // stands on its own; Ichor never becomes more permissive just because a
      // model was unavailable.
      return [
        `Not granted automatically. ${verdict.reason}`,
        '',
        `Your reason: "${reason}"`,
        '',
        budget.allowed
          ? 'Ichor could not find structure in the codebase supporting that.'
          : budget.reason ?? '',
        'This is a decision for the developer rather than for Ichor. Ask them directly, or take the',
        'smaller change that stays on the existing path.',
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'ichor_callers': {
      const symbol = String(args.symbol ?? '').trim();
      if (!symbol) throw new Error('symbol is required');

      const result = await callersOf(
        getGraph(),
        symbol,
        repoIdFor(repoRoot),
        undefined,
        seedIdsFor(repoRoot, symbol),
      );
      if (result.callers.length === 0 && result.routes.length === 0) {
        return (
          `Nothing in the compiled graph calls ${symbol}.\n` +
          'It may be an entry point, called dynamically, or called from outside the analysed ' +
          'files — static analysis is a floor, never a ceiling.'
        );
      }

      const lines = [`${symbol} is reached by:`, ''];
      for (const caller of result.callers) {
        lines.push(`  ${caller.via === 'direct' ? '→' : '⇢'} ${caller.name.padEnd(24)} ${caller.file}`);
      }
      if (result.routes.length) {
        lines.push('', 'Directly behind these endpoints:');
        for (const r of result.routes) lines.push(`  ${r.method} ${r.path}`);
      }
      lines.push('', '→ direct call, ⇢ through a chain.');
      // Rule 2: a bare list that happens to stop at the limit reads as complete.
      if (result.truncated) {
        lines.push(`⚠ truncated at ${result.limit} — there are more.`);
      }
      return lines.join('\n');
    }

    case 'ichor_find': {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query is required');
      const limit = typeof args.limit === 'number' ? args.limit : 15;

      // The same scorer that draws a task boundary. Asking "where does this
      // live?" and "what does this task cover?" are the same question, so they
      // must not drift apart into two answers (ENGINEERING-RULES rule 3).
      // A cache written by an older Ichor can be missing whole fields. Crashing
      // on it would strand anyone who upgrades mid-task, so check the shape and
      // say what to do rather than throwing (rule 2).
      const facts = loadFacts(repoRoot);
      if (!facts || !Array.isArray(facts.functions) || !Array.isArray(facts.types)) {
        return (
          'No usable graph for this repo yet — the cache is missing or was written by an older ' +
          'version of Ichor. Run `ichor watch` here to rebuild it.'
        );
      }

      /**
       * Damping ON here, and OFF when drawing a boundary. Same scorer, opposite
       * setting, because the two jobs want opposite things.
       *
       * A boundary must not MISS the task's code, and damping the commonest word
       * in a domain suppressed the very thing half its tasks are about — measured,
       * it cost 19 points of false alarms. A search must not BURY the answer, and
       * without damping a query for expiry enforcement on a real repo returned
       * `Check`, `BadgeCheck`, `CheckCircle2` and `LinkedIn` — icons, because
       * "check" and "link" are everywhere. With it: `ExpirationSection`,
       * `CleanUrlOnExpire`, `cleanupExpiredJobs`.
       */
      const { anchors, terms } = findAnchors(facts, query, { limit, rarityWeighting: true });
      if (anchors.length === 0) {
        return (
          `Nothing in the compiled graph matches "${query}".\n` +
          `Terms tried: ${terms.join(', ') || '(none usable)'}.`
        );
      }

      /**
       * Keep the best of each KIND, not just the best overall.
       *
       * A codebase has far more functions than tables, so a straight top-N is all
       * functions — on a real repo, a search for link expiry ranked
       * `Link.expiresAt` thirtieth, behind twenty UI components, and the default
       * limit never showed it. The table is often the best answer to "where is
       * this enforced?", because the next question is which endpoints reach it.
       *
       * Done here rather than in the scorer: the scorer's weights were measured
       * against 30 real commits for drawing boundaries, and re-tuning them to
       * flatter a search would trade a measured result for an unmeasured one.
       */
      const byKind = new Map<string, typeof anchors>();
      for (const a of anchors) {
        const list = byKind.get(a.kind) ?? [];
        list.push(a);
        byKind.set(a.kind, list);
      }

      const shown: typeof anchors = [];
      const seen = new Set<string>();
      // Everything that is not a function first — they are rarer and more decisive.
      for (const [kind, list] of byKind) {
        if (kind === 'function') continue;
        for (const a of list.slice(0, 4)) {
          shown.push(a);
          seen.add(a.key);
        }
      }
      for (const a of anchors) {
        if (shown.length >= limit) break;
        if (!seen.has(a.key)) shown.push(a);
      }

      const lines = [`Best matches for "${query}":`, ''];
      for (const a of shown) {
        const where = a.file ? `  ${a.file}` : '';
        lines.push(`  ${a.kind.padEnd(9)} ${a.name.padEnd(34)}${where}`);
        lines.push(`  ${' '.repeat(9)} ${a.why}`);
      }
      lines.push(
        '',
        'Ranked by how specifically each one matches, not by text frequency.',
        'A table or route here is often the better lead: follow it with ichor_paths.',
        'Logic written inline inside a handler has no name of its own — search finds',
        'the handler and the table it touches, not the `if` statement.',
      );
      return lines.join('\n');
    }

    case 'ichor_impact': {
      const symbol = String(args.symbol ?? '').trim();
      if (!symbol) throw new Error('symbol is required');

      const impact = await impactOf(
        getGraph(),
        symbol,
        repoIdFor(repoRoot),
        undefined,
        seedIdsFor(repoRoot, symbol),
      );
      if (impact.kind === 'unknown') {
        return `${symbol} is not in the compiled graph. Check the spelling, or it may be declared in a file Ichor does not analyse.`;
      }

      const lines = [`Changing ${symbol} (${impact.kind}) affects:`, ''];
      lines.push(`  declared in   ${impact.declaredIn.join(', ')}`);

      if (impact.callers.length) {
        lines.push('', `  called by ${impact.callers.length}:`);
        for (const c of impact.callers) {
          lines.push(`    ${c.via === 'direct' ? '→' : '⇢'} ${c.name.padEnd(24)} ${c.file}`);
        }
      } else {
        /**
         * "Nothing calls this" is the most dangerous sentence Ichor can say.
         *
         * It reads as "safe to change", and the old wording — *"an entry point, or
         * called dynamically"* — offered two explanations that are both about the
         * CODE, so a reader concludes the code has no callers. Measured on
         * better-auth: `createAuthEndpoint` produced exactly that line while the
         * source held **304 call sites across 10 packages**. The cause was neither
         * of the two offered reasons; it was that cross-package imports resolve
         * through a `package.json` `exports` map and a workspace link, which
         * name-and-import-path resolution does not follow.
         *
         * So the third possibility is now named, because it is the likeliest one in
         * any monorepo and it is the only one that means *Ichor cannot see*, rather
         * than *there is nothing there*.
         */
        lines.push('', '  called by      nothing in the graph');
        lines.push(
          '                 an entry point, called dynamically, or called from another',
          '                 package — cross-package imports resolve through package.json',
          '                 "exports", which Ichor does not follow. Verify before deleting.',
        );
      }

      if (impact.referencedBy.length) {
        lines.push('', `  shape depended on by ${impact.referencedBy.length}:`);
        for (const r of impact.referencedBy) lines.push(`    ${r.name.padEnd(24)} ${r.file}`);
      }

      if (impact.routes.length) {
        lines.push('', '  reachable from these endpoints:');
        for (const r of impact.routes) lines.push(`    ${r.method} ${r.path}`);
      }

      if (impact.models.length) {
        lines.push('', `  data at stake: ${impact.models.join(', ')}`);
      }

      lines.push('', '→ direct call, ⇢ through a chain. Static analysis is a floor, never a ceiling.');
      if (impact.truncated) lines.push(`⚠ truncated at ${impact.limit} — there are more.`);
      return lines.join('\n');
    }

    case 'ichor_paths': {
      const model = String(args.model ?? '').trim();
      if (!model) throw new Error('model is required');
      const route = typeof args.route === 'string' ? args.route : undefined;

      const graph = getGraph();
      const result = await pathsToModel(graph, model, repoIdFor(repoRoot), { route });

      if (result.paths.length === 0) {
        const touching = await functionsTouching(graph, model, repoIdFor(repoRoot));
        if (touching.functions.length === 0) return `Nothing in the graph touches ${model}.`;
        const lines = [`No HTTP endpoint reaches ${model}, but these functions touch it:`, ''];
        for (const f of touching.functions) lines.push(`  ${f.name.padEnd(24)} ${f.file}`);
        if (touching.truncated) lines.push(`⚠ truncated at ${touching.limit} — there are more.`);
        return lines.join('\n');
      }

      const lines = [`Ways the app reaches ${model}:`, ''];
      for (const p of result.paths) {
        lines.push(`  ${p.method} ${p.route} → ${p.handler} → ${p.reacher} → ${p.model}`);
      }
      lines.push(
        '',
        // Honest about what this is: HydraDB rejects algo.SPpaths over Bolt, so
        // intermediate hops between handler and reacher are not listed.
        'Summaries, not every hop: entry point, handler, the function that touches the data.',
      );
      if (result.truncated) lines.push(`⚠ truncated at ${result.limit} — there are more.`);
      return lines.join('\n');
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
