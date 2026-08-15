/**
 * Drive the MCP server the way an agent does.
 *
 *   npm run mcp:test
 *
 * Speaks real JSON-RPC over stdio to the compiled CLI: initialize, tools/list,
 * then each tool. Checks the handshake is well formed and that the tools answer
 * with the evidence an agent would need.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { analyzeRepo } from '../src/extract/analyze.js';
import { writeGraph } from '../src/graph/write.js';
import { GraphClient, configFromEnv } from '../src/graph/client.js';
import { findAnchors } from '../src/scope/anchors.js';
import { buildNeighborhood } from '../src/scope/neighborhood.js';
import { saveTask, clearTask } from '../src/state.js';

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

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending = new Map<number, (value: Record<string, unknown>) => void>();
  private nextId = 1;

  constructor() {
    this.child = spawn(process.execPath, [CLI, 'mcp', '--repo', REPO], {
      stdio: ['pipe', 'pipe', 'inherit'],
    }) as unknown as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as { id?: number; [k: string]: unknown };
          if (typeof message.id === 'number') {
            this.pending.get(message.id)?.(message);
            this.pending.delete(message.id);
          }
        } catch {
          /* ignore non-JSON */
        }
      }
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

function textOf(response: Record<string, unknown>): string {
  const result = response.result as { content?: { text?: string }[] } | undefined;
  return result?.content?.[0]?.text ?? JSON.stringify(response);
}

let passed = 0;
let total = 0;

function check(label: string, condition: boolean, detail?: string) {
  total++;
  if (condition) passed++;
  console.log(`  ${condition ? '✓' : '✗'} ${label}`);
  if (detail) for (const line of detail.split('\n').slice(0, 6)) console.log(`      │ ${line}`);
}

async function main() {
  // Open a real task so the tools have something to answer about.
  const facts = analyzeRepo(REPO);
  const client = new GraphClient(configFromEnv());
  try {
    await writeGraph(client, facts);
    const { anchors, terms } = findAnchors(facts, TASK);
    saveTask(REPO, await buildNeighborhood(client, TASK, anchors, terms));
  } finally {
    await client.close();
  }

  const mcp = new McpClient();
  try {
    console.log('\n── handshake ───────────────────────────');
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ichor-mcp-test', version: '0' },
    });
    const initResult = init.result as { serverInfo?: { name?: string }; protocolVersion?: string };
    check(`initialize -> ${initResult?.serverInfo?.name} (${initResult?.protocolVersion})`, initResult?.serverInfo?.name === 'ichor');

    const list = await mcp.request('tools/list');
    const tools = (list.result as { tools?: { name: string }[] })?.tools ?? [];
    const names = tools.map((t) => t.name);
    // Named rather than counted: a count assertion fails on every addition and
    // says nothing about which tool went missing.
    const expected = [
      'ichor_task_status',
      'ichor_get_scope',
      'ichor_check_change',
      'ichor_explain',
      'ichor_request_scope_expansion',
      'ichor_callers',
      'ichor_paths',
    ];
    const missing = expected.filter((n) => !names.includes(n));
    check(
      `tools/list -> ${tools.length} tools`,
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : names.join('\n'),
    );

    console.log('\n── tools ───────────────────────────────');

    const status = textOf(await mcp.request('tools/call', { name: 'ichor_task_status', arguments: {} }));
    check('ichor_task_status reports the active task', status.includes('Duplicate email'), status);

    const scope = textOf(
      await mcp.request('tools/call', {
        name: 'ichor_get_scope',
        arguments: { file: 'src/lib/vendors/create.ts' },
      }),
    );
    check('ichor_get_scope shows createVendor in scope', scope.includes('createVendor'), scope);

    const legit = textOf(
      await mcp.request('tools/call', {
        name: 'ichor_check_change',
        arguments: { file: 'src/lib/vendors/create.ts', operation: 'edit' },
      }),
    );
    check('ichor_check_change allows the real fix', legit.startsWith('EXPECTED'), legit);

    const overreach = textOf(
      await mcp.request('tools/call', {
        name: 'ichor_check_change',
        arguments: {
          file: 'src/app/api/vendors/check-email/route.ts',
          operation: 'create',
          content: CHECK_EMAIL,
        },
      }),
    );
    check('ichor_check_change flags the new endpoint', overreach.startsWith('SUSPICIOUS'), overreach);

    const explain = textOf(
      await mcp.request('tools/call', {
        name: 'ichor_explain',
        arguments: { file: 'src/lib/billing/invoice.ts' },
      }),
    );
    check('ichor_explain explains why billing is out', explain.includes('is reachable from this task') && explain.startsWith('Nothing in'), explain);

    const refused = textOf(
      await mcp.request('tools/call', {
        name: 'ichor_request_scope_expansion',
        arguments: {
          file: 'src/lib/billing/invoice.ts',
          reason: 'I want to tidy the invoice helpers while I am here.',
        },
      }),
    );
    check('scope expansion refused without structural support', refused.startsWith('Not granted'), refused);

    const callers = textOf(
      await mcp.request('tools/call', { name: 'ichor_callers', arguments: { symbol: 'createVendor' } }),
    );
    check(
      'ichor_callers finds who reaches createVendor',
      callers.includes('POST') && callers.includes('createVendor is reached by'),
      callers,
    );

    const unknown = textOf(
      await mcp.request('tools/call', { name: 'ichor_callers', arguments: { symbol: 'noSuchFunction' } }),
    );
    // Rule 2: an empty result must say it is empty and why, not look like an answer.
    check(
      'ichor_callers is explicit when nothing calls a symbol',
      unknown.includes('Nothing in the compiled graph calls'),
      unknown,
    );

    const paths = textOf(
      await mcp.request('tools/call', { name: 'ichor_paths', arguments: { model: 'Vendor' } }),
    );
    check(
      'ichor_paths shows how endpoints reach Vendor',
      paths.includes('→ Vendor') && paths.includes('/api/vendors'),
      paths,
    );

    const filtered = textOf(
      await mcp.request('tools/call', {
        name: 'ichor_paths',
        arguments: { model: 'Vendor', route: '/api/vendors' },
      }),
    );
    check('ichor_paths honours the route filter', filtered.includes('/api/vendors'), filtered);

    const granted = textOf(
      await mcp.request('tools/call', {
        name: 'ichor_request_scope_expansion',
        arguments: {
          file: 'src/lib/auth/session.ts',
          reason: 'The route authenticates before creating a vendor, so I must touch it.',
        },
      }),
    );
    check(
      'scope expansion decision for a connected file is reasoned',
      granted.startsWith('Granted') || granted.startsWith('Not granted'),
      granted,
    );
  } finally {
    mcp.close();
    clearTask(REPO);
  }

  console.log(`\n${passed}/${total} MCP checks passed\n`);
  if (passed !== total) process.exitCode = 1;
}

void main();
