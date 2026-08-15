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
 * Speaks MCP over stdio using JSON-RPC 2.0 directly. No SDK: the surface is five
 * tools and adding a dependency for that would be the larger risk.
 */

import * as readline from 'node:readline';
import { GraphClient, configFromEnv } from '../graph/client.js';
import { callersOf, functionsTouching, pathsToModel } from '../graph/queries.js';
import { loadTask, toNeighborhood, markJustified, type PersistedTask } from '../state.js';
import { classify } from '../scope/classify.js';
import { parsePending } from '../scope/pending.js';
import { askJudge, formatOpinion } from '../judge/judge.js';
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
                serverInfo: { name: 'ichor', version: '0.1.0' },
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

async function callTool(
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
        if (verdict.decision === 'SUSPICIOUS' || verdict.decision === 'HUMAN_REVIEW') {
          lines.push(
            '',
            'If this is genuinely required, call ichor_request_scope_expansion with your reason.',
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
          'call ichor_request_scope_expansion and say why.',
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
        { client: getGraph(), neighborhood: toNeighborhood(task), forced: task.forced.map((f) => f.file) },
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

      const result = await callersOf(getGraph(), symbol);
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

    case 'ichor_paths': {
      const model = String(args.model ?? '').trim();
      if (!model) throw new Error('model is required');
      const route = typeof args.route === 'string' ? args.route : undefined;

      const graph = getGraph();
      const result = await pathsToModel(graph, model, { route });

      if (result.paths.length === 0) {
        const touching = await functionsTouching(graph, model);
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
