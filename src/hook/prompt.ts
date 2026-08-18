/**
 * The turn boundary: what happens when the developer types.
 *
 * This is the answer to the failure that makes Ichor useless in real life.
 * Nobody runs a CLI command between tasks — they work all day in one
 * conversation. A boundary drawn at 9am is still policing vendor code at 2pm
 * while the developer is deep in billing, challenging every edit. So the moment
 * a prompt arrives we ask whether it still points at the area we are watching,
 * and move the boundary when it does not.
 *
 * Two hard rules:
 *
 *   1. NEVER block a prompt. This hook writes plain text on stdout and nothing
 *      else — both hosts treat that as extra context. There is deliberately no
 *      code path here that can emit a decision, so a bug cannot cost someone
 *      their message.
 *   2. When unsure, change nothing. Every ambiguous classification resolves to
 *      NO_SIGNAL, which leaves the boundary exactly where it was.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadFacts, loadIndex, refreshInProgress } from '../refresh/refresh.js';
import { findAnchors } from '../scope/anchors.js';
import { buildNeighborhood } from '../scope/neighborhood.js';
import { classifyPrompt, isQuestion, type BoundaryView } from '../scope/taskSwitch.js';
import { GraphClient, configFromEnv } from '../graph/client.js';
import {
  loadTask,
  replaceBoundary,
  saveTask,
  stateDir,
  updateTask,
  type PersistedTask,
} from '../state.js';
import { writeStdoutSync } from './stdout.js';
import type { HookPayload } from './input.js';
import type { GraphFacts } from '../extract/types.js';

/**
 * There is no soft time budget any more, and this note is why.
 *
 * A 1.5-second warning was logged whenever a draw took longer than expected. It was
 * calibrated on a 1,362-file product, and on a 7,741-file monorepo EVERY draw takes
 * 3–7s — so the log said "boundary took longer than the budget" on every single
 * prompt, immediately followed by the boundary succeeding.
 *
 * Nothing was wrong when it appeared, which is the problem. This log is Ichor's own
 * accountability mechanism — the answer to "why did it say nothing?" — and a warning
 * that fires unconditionally on a whole class of repository is noise in the one place
 * that has to carry signal.
 *
 * The duration is now reported on the line that says what happened, where it is
 * information rather than alarm. HARD_LIMIT_MS below still logs, loudly, in the only
 * case that is actually a failure: a draw abandoned unfinished.
 */

/**
 * The point at which the redraw is abandoned rather than allowed to hang.
 *
 * Well above a healthy draw — 1.5s on a 1,362-file repo — so it only fires when
 * something is genuinely wrong, which in practice means a background re-index is
 * holding the database. The host kills a hook that takes too long, and a killed
 * hook writes no log at all, so this exists to make sure Ichor always says what
 * happened.
 */
const HARD_LIMIT_MS = 20_000;

/**
 * How long to let a running rebuild finish before giving up on a redraw.
 *
 * A refresh takes 2–8s on a real repository, so this covers the common case. Long
 * enough to be worth waiting, short enough that a developer does not notice — and
 * far cheaper than the 20-second ceiling it replaces, which was reached only by
 * two processes fighting over the same database.
 */
const REBUILD_WAIT_MS = 9_000;

/**
 * How many file paths the briefing prints.
 *
 * Small because this is paid for in tokens on every single turn. The consequence —
 * that the list is a sample rather than the boundary — is stated in the briefing
 * itself rather than left for the agent to discover.
 */
const FILES_SHOWN = 8;

const WATCH_FILE = 'watch.json';

export const watchPath = (repoRoot: string) => path.join(stateDir(repoRoot), WATCH_FILE);

export function isWatching(repoRoot: string): boolean {
  return fs.existsSync(watchPath(repoRoot));
}

/** Claude Code calls it `user_prompt`; Codex calls it `prompt`. */
export function readPrompt(payload: HookPayload): string {
  for (const key of ['user_prompt', 'prompt'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** Claude Code sends `prompt_id`; Codex sends `turn_id`. Either identifies a turn. */
function readPromptId(payload: HookPayload): string | undefined {
  for (const key of ['prompt_id', 'turn_id'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * How much of the conversation the task description may carry.
 *
 * Widening used to append every prompt to the task text forever. Over two
 * prompts about one job that is right — the boundary should cover both. Over a
 * real session it is not: the text grows without bound, words from twenty
 * prompts ago keep pulling on the boundary, and eventually the task is mostly
 * noise.
 *
 * Observed live: three prompts in, the task was all three concatenated, the
 * boundary came out at 391 functions of nothing in particular, and Ichor
 * challenged an edit to the exact file the developer had just named.
 */
const MAX_TASK_CHARS = 400;

/**
 * Grow a task description without letting it grow forever.
 *
 * The opening prompt is what NAMED the job, so it is always kept. What gets
 * dropped is the middle — the oldest widenings, which are the least likely to
 * still describe what is being worked on.
 */
/**
 * How many prompts a task description may carry.
 *
 * The character cap alone did not hold, because it only engaged once the text was
 * already long. Under 400 characters every prompt was kept verbatim, so a session
 * that opened with "hey claude do one thing pleaes add the retry logic in the api
 * client" carried that greeting into every boundary drawn for the next quarter of
 * an hour.
 *
 * That is not cosmetic. Matching is by substring, so the filler word `one` reached
 * inside Milestone, ScreenshotDropzone and onEscape, and those anchors pulled 185
 * functions -- a third of the repository -- into scope. A boundary that wide
 * cannot challenge anything, and Ichor went quiet without ever saying why.
 *
 * Counting prompts bounds the noise at its source: keep the one that NAMED the
 * job, and what was said most recently.
 */
const MAX_TASK_PROMPTS = 3;

/**
 * Separator between the prompts that make up a task.
 *
 * Chosen because `taskTerms` strips it: anything outside [word, space, slash,
 * dash] becomes a space before terms are extracted, so the separator can never
 * become a term of its own.
 */
const PROMPT_SEP = ' | ';

export function widenTask(existing: string, prompt: string): string {
  const said = existing.split(PROMPT_SEP).map((part) => part.trim()).filter(Boolean);
  const kept = [...said, prompt.trim()].filter(Boolean);
  if (!kept.length) return '';

  /**
   * Drop the MIDDLE -- never the opening, never the newest.
   *
   * The first prompt named the job and the last one says what is happening now.
   * The widenings in between are the ones least likely to still describe the
   * work, which is the same reasoning the character cap used, applied before the
   * text has a chance to grow rather than after.
   */
  const window =
    kept.length <= MAX_TASK_PROMPTS
      ? [...kept]
      : [kept[0]!, ...kept.slice(kept.length - (MAX_TASK_PROMPTS - 1))];

  // Same rule for length: shed old widenings before touching either end.
  while (window.length > 2 && window.join(PROMPT_SEP).length > MAX_TASK_CHARS) {
    window.splice(1, 1);
  }

  const text = window.join(PROMPT_SEP);
  if (text.length <= MAX_TASK_CHARS) return text;

  // Down to two and still too long: keep all of the newest and as much of the
  // opening as fits. The newest is the better description of what is happening.
  const newest = window[window.length - 1]!;
  if (newest.length >= MAX_TASK_CHARS) return newest.slice(0, MAX_TASK_CHARS).trim();
  const room = MAX_TASK_CHARS - newest.length - PROMPT_SEP.length;
  const opening = window[0]!.slice(0, Math.max(0, room)).trim();
  return opening ? `${opening}${PROMPT_SEP}${newest}` : newest;
}

function boundaryOf(task: PersistedTask): BoundaryView {
  return {
    names: [
      ...task.members.map((m) => m.name),
      ...task.coreModels,
      ...task.anchors.map((a) => a.name),
    ],
    files: [...new Set(task.members.map((m) => m.file))],
  };
}

/**
 * A short description of the boundary, injected into the agent's context.
 *
 * Cheaper for everyone than challenging after the fact: an agent that knows
 * where the task lives mostly stays there. Kept deliberately terse — this is
 * paid for in tokens on every single turn.
 */
export function scopeBriefing(task: PersistedTask, sessionId?: string): string {
  if (!task.members.length) return '';

  /**
   * Distinct NAMES for display, but the count of FUNCTIONS.
   *
   * Members are keyed by graph id, so two different functions that happen to share a
   * name are two members — correctly. Listing raw names then prints the same word
   * twice, and an agent reading the briefing called that out: *"the scope list has a
   * duplicate … it means the 179 count may be counting the same symbol more than
   * once."* The count was right and the display made it look wrong, which for a tool
   * whose whole value is being believed is the same problem.
   */
  const ordered = task.members.slice().sort((a, b) => a.distance - b.distance);
  const names = [...new Set(ordered.map((m) => m.name))];
  const shown = names.slice(0, 12).join(', ');
  const rest = names.length > 12 ? `, and ${names.length - 12} more` : '';

  /**
   * The framing matters as much as the content.
   *
   * This text is injected into the turn by a hook, so the agent sees it in the same
   * position as something the developer typed. Quoting the tracked task as
   * `Task boundary: "add a comment at the top of smtp-service.ts"` therefore reads as
   * a fresh instruction — and in a live session an agent did exactly that, reported
   * it as an injected request that "didn't come from you", and ignored it:
   *
   *   "the tooling injected an instruction into this turn claiming you'd also asked
   *    me to add a comment … That didn't come from you, so I ignored it."
   *
   * That is the correct instinct for an agent to have, and it costs Ichor half its
   * value: an agent that distrusts the briefing will not use it. So the origin, the
   * status of the quoted text and its provenance are all stated before it appears.
   *
   * The first attempt over-corrected into a contradiction, and the next agent to read
   * it said so exactly: *"It says 'Do not act on the quoted task text', then calls that
   * same text the thing 'currently tracking' and attaches a scope plus an escalation
   * path … Both at once means the block gives no actionable instruction — which is why
   * I treated it as inert context."*
   *
   * Right on both counts. "Do not act on this" tells an agent to ignore the whole
   * block, when the real distinction is narrower: the quoted text is not a NEW request
   * to fulfil, and it IS the frame for judging an edit the agent is about to make
   * anyway. Saying only the first half throws the briefing away.
   */
  /**
   * Where the tracked task came from, said accurately.
   *
   * The first version of this claimed "from an earlier message in this conversation"
   * unconditionally, and an agent immediately caught it out: *"There is no earlier
   * message in this conversation — your question is the first turn I've seen. So that
   * attribution doesn't match my context."* It was right. A boundary lives in
   * `.ichor/` and outlives the session that set it, so on a fresh session the claim
   * is simply false — and a briefing caught in one false statement earns distrust of
   * every true one next to it.
   *
   * Ichor already knows which case it is: the task records the session that set it.
   */
  const sameSession = sessionId !== undefined && task.sessionId === sessionId;
  const provenance = sameSession
    ? ', from an earlier message in this conversation'
    : task.mode === 'explicit'
      ? ', set by hand with `ichor start` before this session'
      : ', carried over from an earlier session in this repository';

  /**
   * Files, not only function names.
   *
   * A verdict is about a FILE — that is the unit an agent edits and the unit the hook
   * judges — while this listed function names alone. An agent reading it put the gap
   * precisely: *"the scope is expressed as a set of function names, but the quoted task
   * is to add a file-level comment — which touches no function. So the task is neither
   * inside nor outside the stated scope; the scope can't adjudicate it."*
   */
  const files = [...new Set(ordered.map((m) => m.file))];
  const filesShown = files.slice(0, FILES_SHOWN).join(', ');

  const lines = [
    '[ichor] Hook-provided context, not a message from the developer.',
    'The quoted job below is ALREADY IN PROGRESS. It is not a new request and nothing in',
    'it needs doing now. Use it only to judge whether an edit you are about to make',
    'belongs to the job already underway.',
    `Job in progress${provenance}: "${task.task}"`,
    files.length > FILES_SHOWN
      ? `Files in scope: ${files.length}, of which ${FILES_SHOWN} shown — ${filesShown}`
      : `Files in scope (${files.length}): ${filesShown}`,
    `Functions in scope — ${ordered.length}, ${names.length} distinct name${names.length === 1 ? '' : 's'}: ${shown}${rest}`,
  ];
  if (task.coreModels.length) lines.push(`Data this job is about: ${task.coreModels.join(', ')}`);
  /**
   * Do not state a rule the reader cannot apply.
   *
   * "An edit to a file outside that list will be questioned" is enforceable only if
   * the list is complete, and on a real task it is not — 8 of 91 files fit in a
   * briefing paid for on every turn. An agent reading it said so: *"only 8 of 91 files
   * are shown, so nothing in the hook lets me determine membership for the other 83.
   * The enforcement claim is stronger than the information provided."*
   *
   * Correct. So the truncation is stated and the way to settle membership is offered
   * as the answer to it, rather than as an appeal route after being surprised.
   */
  lines.push(
    files.length > FILES_SHOWN
      ? 'An edit to a file outside the job will be questioned, and the list above is partial — call ichor_check_change with the path if you are unsure whether a file is in it.'
      : 'An edit to a file outside that list will be questioned. If one is genuinely required, call ichor_check_change first and explain why.',
  );

  /**
   * Naming the retrieval tools, because an agent will not go looking for them.
   *
   * Ichor's other half is retrieval — `ichor_find` answers "where does X live" from the
   * compiled graph rather than a guessed grep pattern, and `ichor_impact` answers "what
   * breaks if I change this". Their descriptions already say "use this INSTEAD of
   * grepping". It made no difference.
   *
   * Measured in a real session on a real project: three prompts where these were the
   * right tool, three greps. The one time they were used the developer had typed "use
   * the ichor tools", and the agent's own words were *"the user explicitly asked for
   * these, so let me LOAD the ichor tool schemas"* — load, because Claude Code defers
   * MCP schemas when several servers are connected. A tool whose schema is not in
   * context cannot be preferred over one that is, however well its description argues.
   *
   * So the reminder goes here, in the one thing that reaches the agent every prompt.
   * Kept to a single line and phrased as availability rather than instruction: this
   * briefing was rewritten three times because agents distrusted it (finding 14), and
   * turning it into an advert is how that trust gets spent.
   */
  lines.push(retrievalOffer());

  return lines.join('\n');
}

/**
 * One line naming the retrieval tools.
 *
 * Extracted so it can also be said when there is NO task — the case that made the first
 * version of this useless. It lived only inside the scope briefing, and the briefing runs
 * only when a boundary exists. So `ichor watch` followed by a question, which deliberately
 * never creates a boundary, injected nothing at all: the agent never learned the tools
 * existed and went straight to grep. Reported from real use within minutes of shipping.
 *
 * Exploring is when retrieval is worth most. Someone asking "what breaks if I change
 * this" has no task open yet, by definition.
 */
function retrievalOffer(): string {
  return (
    'Available for this repo instead of guessing at grep patterns: ichor_find (where ' +
    'something lives, described in plain words), ichor_impact (what breaks if a symbol ' +
    'changes), ichor_paths (how a table is reached).'
  );
}

/**
 * What to say when no boundary is in play.
 *
 * Deliberately just the tool line and a reason to believe it. There is no scope to police
 * — no task means nothing is out of scope — so anything more would be noise on a turn
 * Ichor has no business shaping. Silent when the repo has never been analysed, since the
 * tools would have nothing to answer from.
 */
function noTaskContext(facts: GraphFacts | undefined): string {
  if (!facts) return '';
  return [
    '[ichor] Hook-provided context, not a message from the developer.',
    'No task is being tracked, so nothing here is out of scope. This repository has a ' +
      `compiled graph of ${facts.functions.length} functions.`,
    retrievalOffer(),
  ].join('\n');
}

export interface PromptOutcome {
  /** For hook.log — every decision has to be explainable. */
  log: string[];
  context: string;
}

/**
 * Decide what this prompt means for the boundary.
 *
 * Returns the text to inject, if any. Never throws — the caller treats a thrown
 * error as "say nothing", but there should be no way to get there.
 */
export async function handlePrompt(
  payload: HookPayload,
  repoRoot: string,
): Promise<PromptOutcome> {
  const log: string[] = [];
  const prompt = readPrompt(payload);
  if (!prompt) return { log: ['prompt: empty -> nothing to do'], context: '' };

  const promptId = readPromptId(payload);
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;

  const existing = loadTask(repoRoot);

  // A hook can fire twice for one turn. Redrawing twice is harmless but noisy in
  // the log, and doubles the work on the one path that has a time budget.
  if (existing && promptId && existing.lastPromptId === promptId) {
    return { log: [`prompt: ${promptId} already handled -> skip`], context: scopeBriefing(existing, sessionId) };
  }

  const facts = loadFacts(repoRoot);
  const index = loadIndex(repoRoot);

  /**
   * A question is not a task.
   *
   * Checked before anything is drawn OR moved. "Where is link expiry enforced?"
   * set a 374-function boundary on papermark, and a boundary from a question is
   * worse than none: nothing is being changed, so there is nothing to protect, and
   * it stays behind for the next real edit to be judged against.
   */
  if (isQuestion(prompt)) {
    return {
      log: ['prompt: a question, not an instruction -> boundary untouched'],
      context: existing ? scopeBriefing(existing, sessionId) : noTaskContext(facts),
    };
  }

  if (!existing) {
    if (!isWatching(repoRoot)) return { log: ['prompt: no task and not watching -> ignore'], context: '' };
    if (!facts) return { log: ['prompt: watching but no analysis yet -> stay silent'], context: '' };

    const created = await drawBoundary(repoRoot, prompt, facts, 'watch', sessionId, log);
    // No boundary drawn — the prompt pointed nowhere specific enough. The tools are
    // still worth naming, because that is exactly when an agent starts guessing.
    if (!created) return { log, context: noTaskContext(facts) };
    updateTask(repoRoot, (t) => ({ ...t, lastPromptId: promptId }));
    return { log, context: scopeBriefing(created, sessionId) };
  }

  if (!index || !facts) {
    return { log: ['prompt: no name index -> cannot classify, staying put'], context: scopeBriefing(existing, sessionId) };
  }

  // A second agent session working in the same repo takes ownership. Recorded
  // rather than resolved: real isolation needs per-session state, which is a
  // bigger change than this one.
  if (sessionId && existing.sessionId && existing.sessionId !== sessionId) {
    log.push(`prompt: session changed (${existing.sessionId} -> ${sessionId})`);
  }

  const verdict = classifyPrompt(prompt, index, boundaryOf(existing));
  log.push(`prompt: ${verdict.verdict} — ${verdict.reason}`);

  if (verdict.verdict === 'NO_SIGNAL' || verdict.verdict === 'SAME') {
    updateTask(repoRoot, (t) => ({ ...t, lastPromptId: promptId, sessionId: sessionId ?? t.sessionId }));
    return { log, context: scopeBriefing(existing, sessionId) };
  }

  // A task the developer named by hand is theirs to move. Detection still runs
  // and still reports, but it does not redraw a boundary somebody chose.
  if (existing.mode === 'explicit') {
    log.push('prompt: task was set explicitly -> reporting only, not redrawing');
    updateTask(repoRoot, (t) => ({ ...t, lastPromptId: promptId }));
    const note =
      verdict.verdict === 'NEW'
        ? `\n[ichor] This looks like a different task (${verdict.outsideHits.join(', ')}). The boundary below is still the one set with \`ichor start\`. Run \`ichor watch\` to let Ichor follow the conversation instead.`
        : '';
    return { log, context: `${scopeBriefing(existing, sessionId)}${note}` };
  }

  // WIDENED keeps the job and its history; NEW is a different job entirely.
  const isNew = verdict.verdict === 'NEW';
  const text = isNew ? prompt : widenTask(existing.task, prompt);
  const drawn = await drawBoundary(
    repoRoot,
    text,
    facts,
    existing.mode,
    sessionId,
    log,
    { replace: true, resetHistory: isNew },
  );

  updateTask(repoRoot, (t) => ({ ...t, lastPromptId: promptId }));
  return { log, context: scopeBriefing(drawn ?? existing, sessionId) };
}

/**
 * Anchor a task sentence and walk the graph outward.
 *
 * Budgeted: if the graph is slow we abandon the redraw and keep the old
 * boundary, because a developer waiting on their own prompt is a worse failure
 * than a boundary that is one turn out of date.
 */
async function drawBoundary(
  repoRoot: string,
  text: string,
  facts: Parameters<typeof findAnchors>[0],
  mode: PersistedTask['mode'],
  sessionId: string | undefined,
  log: string[],
  options: { replace?: boolean; resetHistory?: boolean } = {},
): Promise<PersistedTask | undefined> {
  const { anchors, terms } = findAnchors(facts, text);
  if (anchors.length === 0) {
    // Nothing in the repo matches — a greenfield feature, most likely. An empty
    // boundary would challenge every edit, so we refuse to draw one.
    log.push('prompt: nothing in the repo matches -> staying silent rather than guessing');
    return undefined;
  }

  /**
   * Wait for a running rebuild rather than compete with it.
   *
   * This is bug 6. Finishing a turn that edited files starts a rebuild; prompt
   * again within a few seconds and the boundary draw contends with it, blows
   * through the 20-second ceiling, and Ichor protects NOTHING for that turn.
   * Observed three times in one session, and only visible in the log.
   *
   * Waiting first costs a couple of seconds and usually succeeds — a refresh takes
   * 2–8s and this is called at the very start of a turn, when the agent has not
   * begun editing. Fighting for the database costs twenty seconds and then gives up
   * anyway. If the rebuild is still going after the wait, keeping yesterday's
   * boundary is the honest outcome, and it is said out loud rather than discovered.
   */
  if (refreshInProgress(repoRoot)) {
    const waitedFrom = Date.now();
    while (refreshInProgress(repoRoot) && Date.now() - waitedFrom < REBUILD_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const waited = Date.now() - waitedFrom;
    if (refreshInProgress(repoRoot)) {
      log.push(
        `prompt: a rebuild is still running after ${(waited / 1000).toFixed(1)}s -> keeping the ` +
          'current boundary. The next prompt will redraw against the fresh graph.',
      );
      return undefined;
    }
    log.push(`prompt: waited ${(waited / 1000).toFixed(1)}s for a rebuild to finish, then drew`);
  }

  const client = new GraphClient(configFromEnv());
  const startedAt = Date.now();
  try {
    /**
     * A hard ceiling, not just a warning.
     *
     * The budget above only ever LOGGED an overrun; nothing stopped the walk. So
     * when a background re-index was holding the database — which happens
     * routinely, because finishing a turn starts one — the boundary draw stalled,
     * the host killed the hook, and the log kept the `--- UserPromptSubmit`
     * header with nothing after it. Observed twice on a real repo: no task was
     * set, no reason was recorded, and Ichor simply went quiet for the rest of
     * the session.
     *
     * Losing the redraw is survivable; going silent without saying so is not.
     */
    const neighborhood = await Promise.race([
      buildNeighborhood(client, text, anchors, terms),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), HARD_LIMIT_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);

    if (!neighborhood) {
      log.push(
        `prompt: boundary took longer than ${HARD_LIMIT_MS / 1000}s — keeping the previous one. ` +
          'A rebuild is probably still running; the next prompt will redraw.',
      );
      return undefined;
    }

    const task = options.replace
      ? replaceBoundary(repoRoot, neighborhood, { resetHistory: options.resetHistory ?? false })
      : saveTask(repoRoot, neighborhood, { mode, sessionId });

    log.push(
      `prompt: boundary set — ${neighborhood.members.size} functions in ` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    if (neighborhood.stats.truncated) {
      // Rule 2: a boundary that stopped early is not the same as one that
      // finished, and everything it did not reach will be challenged.
      log.push(`prompt: ⚠ the task area hit the member cap — edits just outside it may be questioned`);
    }
    return task;
  } catch (error) {
    log.push(`prompt: could not reach the graph (${(error as Error).message.slice(0, 80)})`);
    return undefined;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Emit the briefing. Plain text only — this hook can never block a prompt. */
export function emitContext(context: string): void {
  if (context.trim()) writeStdoutSync(`${context}\n`);
}
