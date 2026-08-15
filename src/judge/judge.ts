/**
 * The Ichor Judge.
 *
 * The graph decides what is CONNECTED. It cannot decide what is NECESSARY —
 * that needs an understanding of what the developer asked for. So the split is:
 *
 *   static analysis + HydraDB  ->  structural evidence
 *   the Judge (LLM)            ->  intent reasoning
 *   the human                  ->  final authority
 *
 * 🔒 Two rules the Judge must never break:
 *
 *   1. It cannot invent structure. It receives graph facts and reasons about
 *      them. If it claims a path exists, that claim carries no weight — only
 *      the evidence we handed it does.
 *
 *   2. The agent's confidence is not evidence. "This improves UX" is a reason,
 *      not proof that the task requires it. A convincing argument with no
 *      structural support must still be refused.
 *
 * GRAPH FIRST, LLM SECOND. Obvious cases never reach here — that is both
 * correctness (deterministic answers where possible) and cost control.
 */

import { complete, judgeConfigFromEnv, isJudgeAvailable, type OpenRouterConfig } from './openrouter.js';
import type { Verdict } from '../scope/classify.js';
import type { Neighborhood } from '../scope/neighborhood.js';

export type JudgeDecision =
  | 'EXPECTED'
  | 'SUPPORTED_EXPANSION'
  | 'SUSPICIOUS_EXPANSION'
  | 'HUMAN_DECISION';

export interface JudgeOpinion {
  decision: JudgeDecision;
  confidence: 'low' | 'medium' | 'high';
  /** What the task actually requires, in the Judge's reading. */
  taskRequirement: string;
  /** What the agent claims, restated. */
  agentClaim: string;
  supporting: string[];
  contradicting: string[];
  recommendation: string;
  /** Which model answered — shown so a verdict is attributable. */
  model: string;
}

export interface JudgeRequest {
  neighborhood: Neighborhood;
  /** The graph-derived verdict that triggered this. */
  verdict: Verdict;
  file: string;
  /** The agent's justification, when it gave one. */
  agentReason?: string;
}

const SYSTEM = `You are Ichor's Judge. You decide whether an AI coding agent's change still belongs to the task it was given.

You will be given:
- the developer's task, in their words
- STRUCTURAL EVIDENCE extracted from the real codebase (a call graph in a database)
- the change the agent wants to make
- optionally, the agent's own justification

Rules you must follow:

1. The structural evidence is the ONLY fact base. You must not assume any code
   relationship that is not in the evidence. If the evidence does not show a
   connection, there is no connection as far as you are concerned.

2. The agent's justification is a CLAIM, never proof. A plausible or confident
   reason with no structural support is still unjustified. Refusing a
   good-sounding argument is correct behaviour.

3. Prefer the smaller change. If the requested outcome can be achieved on a path
   that already exists, a new endpoint, abstraction, service or flow is an
   expansion that needs to earn its place.

4. When the change may be a legitimate product decision but is not required by
   the task, that is HUMAN_DECISION. Do not decide product direction yourself.

5. Separate CONTRADICTED from UNVERIFIABLE, and treat them differently.

   - The evidence shows the claim is false, or shows an existing path that
     already does the job -> SUSPICIOUS_EXPANSION.
   - The claim is about something a call graph structurally CANNOT see — the
     order of screens in a wizard, what a user does before submitting, timing,
     UX or product intent — and nothing in the evidence contradicts it ->
     HUMAN_DECISION.

   The absence of evidence for a claim of that kind is not evidence against it.
   A graph of functions has no way to know a form has five steps. Refusing such
   a claim outright asserts something you cannot know; ask the developer instead.

6. Be brief and concrete. Cite the evidence you relied on.

Answer with JSON only, in exactly this shape:
{
  "decision": "EXPECTED" | "SUPPORTED_EXPANSION" | "SUSPICIOUS_EXPANSION" | "HUMAN_DECISION",
  "confidence": "low" | "medium" | "high",
  "taskRequirement": "one sentence on what the task actually requires",
  "agentClaim": "one sentence restating the agent's reason, or 'none given'",
  "supporting": ["evidence that supports the change"],
  "contradicting": ["evidence that argues against it"],
  "recommendation": "one sentence to the agent"
}`;

/** Build the user message. Only real evidence goes in — never speculation. */
export function buildPrompt(request: JudgeRequest): string {
  const { neighborhood, verdict, file, agentReason } = request;

  const inScope = [...neighborhood.members.values()]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 15)
    .map((m) => `  - ${m.name} (${m.file}) — distance ${m.distance}, ${m.reason}`);

  const lines = [
    `DEVELOPER'S TASK:`,
    neighborhood.task,
    ``,
    `THE DATA THIS TASK IS ABOUT: ${[...neighborhood.coreModels].join(', ') || '(none identified)'}`,
    ``,
    `CODE CURRENTLY CONSIDERED PART OF THE TASK (from the call graph):`,
    ...inScope,
    ``,
    `THE CHANGE THE AGENT WANTS TO MAKE:`,
    `  file: ${file}`,
    `  Ichor's structural reading: ${verdict.reason}`,
    ``,
    `STRUCTURAL EVIDENCE:`,
    ...(verdict.evidence.length
      ? verdict.evidence.map((e) => `  - [${e.kind}] ${e.text}`)
      : ['  (none — nothing connects this change to the task)']),
    ``,
    `THE AGENT'S JUSTIFICATION:`,
    agentReason ? `  "${agentReason}"` : '  (none given)',
  ];

  return lines.join('\n');
}

/**
 * Ask the Judge.
 *
 * Returns undefined when there is no API key, the model is unreachable, or the
 * reply cannot be parsed. Every one of those degrades to the graph-only verdict
 * — the product must work with no key at all.
 */
export async function askJudge(
  request: JudgeRequest,
  config: OpenRouterConfig = judgeConfigFromEnv(),
): Promise<JudgeOpinion | undefined> {
  if (!isJudgeAvailable(config)) return undefined;

  const answer = await complete(config, SYSTEM, buildPrompt(request));
  if (!answer) return undefined;

  return parseOpinion(answer.content, answer.model);
}

const DECISIONS: JudgeDecision[] = [
  'EXPECTED',
  'SUPPORTED_EXPANSION',
  'SUSPICIOUS_EXPANSION',
  'HUMAN_DECISION',
];

/**
 * Parse the reply.
 *
 * Strict: an unparseable or unrecognised answer returns undefined rather than a
 * guess. A malformed verdict presented as a real one would be exactly the kind
 * of invented authority this whole design avoids.
 */
export function parseOpinion(raw: string, model: string): JudgeOpinion | undefined {
  const json = extractJson(raw);
  if (!json) return undefined;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const decision = String(parsed.decision ?? '') as JudgeDecision;
  if (!DECISIONS.includes(decision)) return undefined;

  const confidence = String(parsed.confidence ?? 'low');

  return {
    decision,
    confidence: confidence === 'high' || confidence === 'medium' ? confidence : 'low',
    taskRequirement: String(parsed.taskRequirement ?? '').trim(),
    agentClaim: String(parsed.agentClaim ?? 'none given').trim(),
    supporting: toStringArray(parsed.supporting),
    contradicting: toStringArray(parsed.contradicting),
    recommendation: String(parsed.recommendation ?? '').trim(),
    model,
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean).slice(0, 6);
}

/** Models sometimes wrap JSON in prose or a fence despite being asked not to. */
function extractJson(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}

/** Render an opinion for the agent to read. */
export function formatOpinion(opinion: JudgeOpinion): string {
  const lines = [`Ichor Judge: ${opinion.decision} (${opinion.confidence} confidence)`];
  if (opinion.taskRequirement) lines.push('', `The task requires: ${opinion.taskRequirement}`);
  if (opinion.agentClaim && opinion.agentClaim !== 'none given') {
    lines.push(`Your claim: ${opinion.agentClaim}`);
  }
  if (opinion.contradicting.length) {
    lines.push('', 'Against:');
    for (const point of opinion.contradicting) lines.push(`  · ${point}`);
  }
  if (opinion.supporting.length) {
    lines.push('', 'For:');
    for (const point of opinion.supporting) lines.push(`  · ${point}`);
  }
  if (opinion.recommendation) lines.push('', opinion.recommendation);
  return lines.join('\n');
}
