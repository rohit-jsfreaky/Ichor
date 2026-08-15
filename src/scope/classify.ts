/**
 * Decide whether a change still belongs to the task.
 *
 * THE TWO TESTS (CLAUDE.md — if you only implement the first, the demo fails):
 *
 *   TEST 1  Is this connected to the task?          graph reachability
 *   TEST 2  Does an existing path already do this?  the new-flow test
 *
 * Test 2 is the one nothing else can do. A new /api/vendors/check-email route
 * PASSES test 1 — it imports Prisma, queries Vendor by email, sits with the
 * other vendor routes. It is wrong because the submit path already reaches the
 * `email @unique` constraint, so it is a second flow for a rule already
 * enforced.
 *
 * Silence is the default. When uncertain we stay quiet: a tool that questions
 * every third edit is uninstalled the same afternoon (PROJECT_FINAL.md §32).
 */

import type { GraphClient } from '../graph/client.js';
import { gInt } from '../graph/client.js';
import type { Neighborhood } from './neighborhood.js';
import type { PendingFacts } from './pending.js';

export type Decision = 'EXPECTED' | 'CONNECTED' | 'SUSPICIOUS' | 'HUMAN_REVIEW';

export interface Evidence {
  kind: 'path' | 'member' | 'model' | 'existing-flow' | 'note';
  text: string;
}

export interface Verdict {
  decision: Decision;
  /** One sentence, shown to the agent. Always cites something real. */
  reason: string;
  evidence: Evidence[];
  /** Only present when we are challenging — what the agent must answer. */
  question?: string;
  /** True when a Judge call is warranted (ambiguous, not obvious). */
  needsJudge: boolean;
}

export interface ChangeIntent {
  operation: 'edit' | 'create' | 'delete';
  /** Repo-relative, POSIX. */
  file: string;
  /** Proposed content, when the host provides it. */
  content?: string;
}

/**
 * Distance at which membership still means "this IS the task".
 *
 * Zero, deliberately. An anchor is a place the task text pointed at directly.
 * Anything further is *reachable from* the task, which is a weaker claim and
 * has to be corroborated by the data the code works on — otherwise every file
 * a route happens to call (auth, logging, config) reads as part of every task.
 *
 * Distance >0 is not treated as suspicious by itself; it goes to the model
 * overlap check, and a shared-data result is CONNECTED and silent.
 */
const EXPECTED_MAX_DISTANCE = 0;

export interface ClassifyDeps {
  client: GraphClient;
  neighborhood: Neighborhood;
  /** Parsed pending content, when the operation carries content. */
  pending?: PendingFacts;
}

export async function classify(intent: ChangeIntent, deps: ClassifyDeps): Promise<Verdict> {
  const { neighborhood } = deps;
  const evidence: Evidence[] = [];

  const membersInFile = [...neighborhood.members.values()].filter((m) => m.file === intent.file);

  // ---- existing file, but nothing in it belongs to the task ---------------
  // Distinct from a genuinely new file. A file that exists in the graph and has
  // no member here is code the task never reaches — the "I was cleaning up a
  // helper while I was here" case.
  if (membersInFile.length === 0) {
    const outside = await existingFileOutsideTask(intent.file, deps);
    if (outside) return outside;
  }

  // ---- existing file, part of the task ------------------------------------
  if (membersInFile.length > 0) {
    const nearest = membersInFile.reduce((a, b) => (a.distance <= b.distance ? a : b));

    for (const m of membersInFile.slice(0, 4)) {
      evidence.push({ kind: 'member', text: `${m.name} (distance ${m.distance}) — ${m.reason}` });
    }

    if (nearest.distance <= EXPECTED_MAX_DISTANCE) {
      return {
        decision: 'EXPECTED',
        reason: `${intent.file} is part of the task neighbourhood (${nearest.name}, distance ${nearest.distance}).`,
        evidence,
        needsJudge: false,
      };
    }

    // Further out. Distance alone is not enough here: auth/session.ts is two
    // hops from the route simply because the route authenticates, yet it has
    // nothing to do with a duplicate-email bug. The signal that separates them
    // is whether the file works on the same DATA as the task.
    const overlap = await modelOverlap(deps, membersInFile.map((m) => m.id));
    const taskModels = neighborhood.coreModels;

    if (overlap.shared.length > 0) {
      evidence.push({
        kind: 'model',
        text: `works on ${overlap.shared.join(', ')}, which the task also touches`,
      });
      return {
        decision: 'CONNECTED',
        reason: `${intent.file} is ${nearest.distance} hops from the task but works on the same data (${overlap.shared.join(', ')}).`,
        evidence,
        needsJudge: false,
      };
    }

    if (overlap.foreign.length > 0) {
      evidence.push({
        kind: 'model',
        text: `works on ${overlap.foreign.join(', ')}; the task works on ${[...taskModels].join(', ') || 'no models'}`,
      });
      return {
        decision: 'SUSPICIOUS',
        reason:
          `${intent.file} is reachable from the task only through ${nearest.name} (distance ${nearest.distance}), ` +
          `and it operates on ${overlap.foreign.join(', ')} rather than the data this task is about.`,
        evidence,
        question: `Why does "${neighborhood.task}" require a change in ${intent.file}?`,
        needsJudge: true,
      };
    }

    // Reachable, touches no data either way. Genuinely ambiguous — a shared
    // helper legitimately looks like this, so we do not challenge on our own.
    return {
      decision: 'CONNECTED',
      reason: `${intent.file} is ${nearest.distance} hops from the task via ${nearest.name}.`,
      evidence,
      needsJudge: false,
    };
  }

  // ---- new file -----------------------------------------------------------
  // Being new is not suspicious. Legitimate work creates tests, components and
  // modules constantly. What matters is what it reaches.
  const pending = deps.pending;

  if (!pending) {
    evidence.push({ kind: 'note', text: 'no content available for a file outside the graph' });
    return {
      decision: 'HUMAN_REVIEW',
      reason: `${intent.file} is not in the graph and no content was provided, so it cannot be assessed.`,
      evidence,
      question: `What is ${intent.file} for, and how does it serve "${neighborhood.task}"?`,
      needsJudge: false,
    };
  }

  if (pending.parseError) {
    evidence.push({ kind: 'note', text: `could not parse: ${pending.parseError}` });
    return {
      decision: 'CONNECTED',
      reason: `${intent.file} could not be parsed, so Ichor is staying out of the way.`,
      evidence,
      needsJudge: false,
    };
  }

  if (pending.isTest) {
    return {
      decision: 'EXPECTED',
      reason: `${intent.file} is a test. Adding tests for a fix is expected.`,
      evidence: [{ kind: 'note', text: 'test files are always in scope' }],
      needsJudge: false,
    };
  }

  // TEST 1 — does it reach the task?
  const reach = reachIntoNeighborhood(pending, neighborhood);
  for (const hit of reach.evidence) evidence.push(hit);

  // TEST 2 — does an existing path already do this?
  const duplicate = await findDuplicateFlow(pending, deps);
  if (duplicate) {
    evidence.push({ kind: 'existing-flow', text: duplicate.existingPath });
    return {
      decision: 'SUSPICIOUS',
      reason:
        `${intent.file} introduces a new ${duplicate.newFlowKind} that reaches ${duplicate.model}, ` +
        `but the task's existing path already reaches it: ${duplicate.existingPath}.`,
      evidence,
      question:
        `The existing ${duplicate.existingEntry} already reaches ${duplicate.model}` +
        `${duplicate.constraintNote}. Why is a separate ${duplicate.newFlowKind} required?`,
      needsJudge: true,
    };
  }

  if (reach.connected) {
    return {
      decision: 'CONNECTED',
      reason: `${intent.file} is new but connects to the task (${reach.summary}).`,
      evidence,
      needsJudge: false,
    };
  }

  return {
    decision: 'SUSPICIOUS',
    reason: `${intent.file} is new and Ichor found no connection to the task.`,
    evidence: evidence.length ? evidence : [{ kind: 'note', text: 'no imports or calls reach the task neighbourhood' }],
    question: `How does ${intent.file} serve "${neighborhood.task}"?`,
    needsJudge: true,
  };
}

// ---------------------------------------------------------------- internals

/**
 * A file that exists in the codebase but sits entirely outside the task.
 *
 * Returns undefined when the file is not in the graph at all, so the caller can
 * fall through to the new-file logic.
 */
async function existingFileOutsideTask(
  file: string,
  deps: ClassifyDeps,
): Promise<Verdict | undefined> {
  const rows = await deps.client.run(
    `MATCH (f:File)-[:DECLARES]->(fn:Function)
       WHERE f.path = $path
       RETURN fn.id AS id, fn.name AS name`,
    { path: file },
  );
  if (rows.records.length === 0) return undefined; // not in the graph — a new file

  const functionIds = rows.records.map((r) => Number(r.get('id')));
  const names = rows.records.map((r) => String(r.get('name')));
  const overlap = await modelOverlap(deps, functionIds);

  const evidence: Evidence[] = [
    { kind: 'note', text: `declares ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` (+${names.length - 4})` : ''}` },
    { kind: 'note', text: 'no function in this file is reachable from the task' },
  ];
  if (overlap.foreign.length) {
    evidence.push({ kind: 'model', text: `works on ${overlap.foreign.join(', ')}` });
  }

  return {
    decision: 'SUSPICIOUS',
    reason:
      `${file} exists in the codebase but nothing in it is reachable from the task` +
      (overlap.foreign.length ? `, and it works on ${overlap.foreign.join(', ')}` : '') +
      '.',
    evidence,
    question: `Why does "${deps.neighborhood.task}" require a change in ${file}?`,
    needsJudge: true,
  };
}

/** Models touched by a set of functions, split by whether the TASK is about them. */
async function modelOverlap(
  deps: ClassifyDeps,
  functionIds: number[],
): Promise<{ shared: string[]; foreign: string[] }> {
  const taskModels = deps.neighborhood.coreModels;
  const shared = new Set<string>();
  const foreign = new Set<string>();

  for (const id of functionIds) {
    const rows = await deps.client.run(
      `MATCH (f:Function {id: $id})-[:TOUCHES]->(m:Model) RETURN m.name AS name`,
      { id: gInt(id) },
    );
    for (const record of rows.records) {
      const name = String(record.get('name'));
      (taskModels.has(name) ? shared : foreign).add(name);
    }
  }

  // A model in both sets is shared — presence in the task wins.
  for (const name of shared) foreign.delete(name);
  return { shared: [...shared], foreign: [...foreign] };
}

/** TEST 1: does the pending file reach the task neighbourhood? */
function reachIntoNeighborhood(
  pending: PendingFacts,
  neighborhood: Neighborhood,
): { connected: boolean; summary: string; evidence: Evidence[] } {
  const memberNames = new Set([...neighborhood.members.values()].map((m) => m.name));
  const memberFiles = new Set([...neighborhood.members.values()].map((m) => m.file));
  const taskModels = new Set([...neighborhood.models.values()].map((m) => m.name));
  const evidence: Evidence[] = [];

  const calledMembers = pending.callsNames.filter((n) => memberNames.has(n));
  const importedMembers = pending.importsRepoFiles.filter((f) =>
    [...memberFiles].some((mf) => mf.replace(/\.(ts|tsx)$/, '') === f),
  );
  const sharedModels = pending.touches
    .map((t) => t.model)
    .filter((m) => [...taskModels].some((tm) => tm.toLowerCase() === m.toLowerCase()));

  if (calledMembers.length) evidence.push({ kind: 'path', text: `calls ${calledMembers.join(', ')}` });
  if (importedMembers.length) evidence.push({ kind: 'path', text: `imports ${importedMembers.join(', ')}` });
  if (sharedModels.length) evidence.push({ kind: 'model', text: `touches ${[...new Set(sharedModels)].join(', ')}` });

  const parts = [
    calledMembers.length ? `calls ${calledMembers.length} function(s) in scope` : '',
    importedMembers.length ? `imports ${importedMembers.length} file(s) in scope` : '',
    sharedModels.length ? `touches ${[...new Set(sharedModels)].join(', ')}` : '',
  ].filter(Boolean);

  return {
    connected: parts.length > 0,
    summary: parts.join('; '),
    evidence,
  };
}

interface DuplicateFlow {
  /** route / entry point */
  newFlowKind: string;
  model: string;
  existingEntry: string;
  existingPath: string;
  constraintNote: string;
}

/**
 * TEST 2 — the new-flow test.
 *
 * Fires when the pending file introduces a NEW ENTRY POINT (an HTTP route)
 * reaching a model that the task's existing path already reaches. That is the
 * shape of "you built a second door to a room that already had one".
 *
 * Deliberately narrow. A broad version would challenge every new helper that
 * happens to read a model the task also reads, which is most legitimate work.
 */
async function findDuplicateFlow(
  pending: PendingFacts,
  deps: ClassifyDeps,
): Promise<DuplicateFlow | undefined> {
  if (pending.routeMethods.length === 0) return undefined; // not a new entry point
  if (pending.touches.length === 0) return undefined;      // reaches no data

  const { neighborhood, client } = deps;

  for (const touch of pending.touches) {
    const taskModel = [...neighborhood.models.values()].find(
      (m) => m.name.toLowerCase() === touch.model.toLowerCase(),
    );
    if (!taskModel) continue;

    // Find the route in the task neighbourhood that already reaches this model,
    // and the chain that gets there. This is the sentence the agent is shown, so
    // it must come from the graph rather than be asserted.
    const rows = await client.run(
      `MATCH (r:Route)-[:HANDLED_BY]->(h:Function)-[:CALLS*1..4]->(f:Function)-[:TOUCHES]->(m:Model)
         WHERE m.name = $model
         RETURN r.method AS method, r.path AS path, h.name AS handler, f.name AS reacher
         LIMIT 5`,
      { model: taskModel.name },
    );

    const inScope = rows.records.find((record) => {
      const handler = String(record.get('handler'));
      return [...neighborhood.members.values()].some((m) => m.name === handler);
    });
    if (!inScope) continue;

    const method = String(inScope.get('method'));
    const routePath = String(inScope.get('path'));
    const handler = String(inScope.get('handler'));
    const reacher = String(inScope.get('reacher'));

    // If the model has a unique constraint on a field the task named, say so —
    // it is usually the whole reason the extra endpoint is unnecessary.
    const uniqueRows = await client.run(
      `MATCH (m:Model)-[:HAS_FIELD]->(f:Field)
         WHERE m.name = $model AND f.isUnique = true
         RETURN f.name AS name LIMIT 3`,
      { model: taskModel.name },
    );
    const uniqueFields = uniqueRows.records
      .map((r) => String(r.get('name')))
      .filter((name) => neighborhood.terms.some((t) => name.toLowerCase().includes(t)));

    return {
      newFlowKind: `${pending.routeMethods.join('/')} endpoint at ${pending.routePath}`,
      model: taskModel.name,
      existingEntry: `${method} ${routePath}`,
      existingPath: `${method} ${routePath} → ${handler} → ${reacher} → ${taskModel.name}`,
      constraintNote: uniqueFields.length
        ? `, where ${taskModel.name}.${uniqueFields[0]} is already unique`
        : '',
    };
  }

  return undefined;
}
