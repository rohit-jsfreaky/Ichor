/**
 * Is the task boundary right? Measured against real commits, not opinion.
 *
 *   npx tsx scripts/ground-truth.ts collect <repo>   <- one-off, needs git history
 *   npx tsx scripts/ground-truth.ts measure <repo>   <- sweeps candidate rules
 *
 * WHY THIS EXISTS
 *
 * Every previous boundary decision was made by looking at a number and judging
 * whether it felt right. That is how the outward walk ended up at 3 hops and the
 * shared-code line at 25 — defensible guesses, but guesses, and a guess cannot
 * tell you the thing that actually matters: does the boundary CONTAIN the work?
 *
 * A boundary that is too wide misses real scope creep. A boundary that is too
 * narrow challenges correct work, which is what gets a tool uninstalled. Those
 * pull in opposite directions, so "smaller is better" is wrong and no amount of
 * staring at boundary sizes resolves it.
 *
 * A real repository's history is full of labelled examples. Every commit is a
 * task (its message) plus the exact functions a developer changed to do it. So:
 *
 *   recall  share of the really-changed functions that fall INSIDE the boundary
 *           — anything outside would have been challenged, wrongly
 *   size    boundary as a share of the repo — how much Ichor stays silent about
 *
 * Recall is the constraint; size is what we minimise subject to it.
 *
 * HOW THE TRUTH IS BUILT, AND WHY IT IS HONEST
 *
 * `collect` checks out each commit and analyses the code AS IT WAS, so the diff's
 * line numbers and the function ranges come from the same snapshot. Mapping a
 * changed line to a function using today's line numbers would silently mis-assign
 * every line in every file that has moved since, and the resulting "measurement"
 * would be worse than no measurement at all.
 *
 * `measure` then evaluates against the CURRENT graph, keeping only truth
 * functions that still exist under the same file and name. Commits whose code
 * has since been renamed or deleted contribute less, and the number dropped is
 * reported rather than hidden (rule 2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { analyzeRepo } from '../src/extract/analyze.js';
import { loadFacts } from '../src/refresh/refresh.js';
import { findAnchors } from '../src/scope/anchors.js';
import { buildNeighborhood, type BuildOptions } from '../src/scope/neighborhood.js';
import { GraphClient, configFromEnv } from '../src/graph/client.js';
import { repoIdFor } from '../src/ids.js';

const CACHE = path.resolve('.ground-truth');
const TARGET_COMMITS = 30;
/** How far back to look for usable commits before giving up. */
const SEARCH_DEPTH = 400;

interface TruthCase {
  sha: string;
  task: string;
  /** `file#name` of every function the commit actually changed. */
  changed: string[];
  /** Every file the commit actually changed — what Ichor actually judges. */
  files?: string[];
  /** Lines that changed outside any function — imports, config, JSX-only edits. */
  linesOutsideFunctions: number;
  filesChanged: number;
}

const git = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * Commits that read as a task.
 *
 * The filter is about whether the MESSAGE can serve as a prompt, never about
 * what the commit touches — filtering on content would be choosing the cases
 * Ichor does well on, which is not a measurement.
 */
function selectCommits(repo: string): { sha: string; subject: string; files: string[] }[] {
  const log = git(repo, [
    'log', '--no-merges', `-n${SEARCH_DEPTH}`, '--pretty=format:%H%x1f%s',
  ]).split('\n');

  const chosen: { sha: string; subject: string; files: string[] }[] = [];

  for (const line of log) {
    const [sha, subject] = line.split('\x1f');
    if (!sha || !subject) continue;

    // Housekeeping commits describe no task.
    if (/^(chore|ci|build|release|docs|style|test|revert)\b/i.test(subject)) continue;
    if (/\b(bump|merge|wip|lint|format|prettier|eslint|version)\b/i.test(subject)) continue;
    if (/^v?\d+\.\d+/.test(subject)) continue;
    // Too short to describe anything.
    if (subject.replace(/^\w+(\([^)]*\))?:\s*/, '').length < 18) continue;

    let files: string[];
    try {
      /**
       * EVERY file the commit touched, not just TypeScript.
       *
       * This used to keep only `.ts`/`.tsx`, which is why the published 19.3%
       * false-alarm figure looked respectable: it never tested a JSON, CSS,
       * Markdown or Prisma edit. Ichor analyses only TypeScript, so every one of
       * those is absent from the graph and therefore challenged — a whole class
       * of false alarm the measurement was blind to by construction.
       *
       * A developer changing `locales/en/viewer.json` while fixing a message is
       * doing the task. If Ichor interrupts that, the number has to say so.
       */
      files = git(repo, ['diff', '--name-only', `${sha}^`, sha])
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0 && !/\.d\.ts$/.test(f));
    } catch {
      continue; // no parent (root commit)
    }

    // One file is often too trivial to have a boundary; more than eight is a
    // sweeping refactor rather than a task.
    if (files.length < 1 || files.length > 8) continue;

    chosen.push({ sha, subject, files });
    if (chosen.length >= TARGET_COMMITS) break;
  }

  return chosen;
}

/** Line ranges touched on the NEW side of a diff, per file. */
function changedLines(repo: string, sha: string, file: string): number[] {
  let diff: string;
  try {
    diff = git(repo, ['diff', '--unified=0', `${sha}^`, sha, '--', file]);
  } catch {
    return [];
  }

  const lines: number[] = [];
  for (const hunk of diff.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunk);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // A pure deletion reports `+start,0`; the edit still happened there.
    if (count === 0) lines.push(start);
    else for (let i = 0; i < count; i++) lines.push(start + i);
  }
  return lines;
}

function collect(repo: string): void {
  const original = git(repo, ['rev-parse', 'HEAD']);
  const commits = selectCommits(repo);
  console.log(`\n  ${commits.length} commits selected from the last ${SEARCH_DEPTH}\n`);

  const cases: TruthCase[] = [];

  try {
    for (const [index, commit] of commits.entries()) {
      git(repo, ['checkout', '--quiet', commit.sha]);

      let facts;
      try {
        facts = analyzeRepo(repo);
      } catch (error) {
        console.log(`  ${index + 1}/${commits.length} SKIP ${commit.sha.slice(0, 8)} — ${(error as Error).message.slice(0, 60)}`);
        continue;
      }

      // Functions grouped by file, so a line lookup is cheap.
      const byFile = new Map<string, typeof facts.functions>();
      for (const fn of facts.functions) {
        const list = byFile.get(fn.file) ?? [];
        list.push(fn);
        byFile.set(fn.file, list);
      }

      const changed = new Set<string>();
      let outside = 0;

      for (const file of commit.files) {
        // Only TypeScript has functions to attribute a changed line to. Other
        // file types still count as files the commit touched — that is what the
        // false-alarm measurement judges — they simply contribute no function.
        if (!/\.tsx?$/.test(file)) continue;
        const candidates = byFile.get(file) ?? [];
        for (const line of changedLines(repo, commit.sha, file)) {
          // The INNERMOST function containing the line owns it: a handler inside
          // a component is a more precise answer than the component.
          let owner: (typeof candidates)[number] | undefined;
          for (const fn of candidates) {
            if (line < fn.line || line > fn.endLine) continue;
            if (!owner || fn.endLine - fn.line < owner.endLine - owner.line) owner = fn;
          }
          if (owner) changed.add(`${owner.file}#${owner.name}`);
          else outside++;
        }
      }

      cases.push({
        sha: commit.sha,
        task: commit.subject,
        changed: [...changed],
        files: commit.files,
        linesOutsideFunctions: outside,
        filesChanged: commit.files.length,
      });
      console.log(
        `  ${String(index + 1).padStart(2)}/${commits.length} ${commit.sha.slice(0, 8)} ` +
          `${String(changed.size).padStart(3)} functions  ${commit.subject.slice(0, 62)}`,
      );
    }
  } finally {
    git(repo, ['checkout', '--quiet', original]);
    console.log(`\n  restored ${original.slice(0, 8)}`);
  }

  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'cases.json'), JSON.stringify(cases, null, 2), 'utf8');
  console.log(`  wrote ${cases.length} cases to .ground-truth/cases.json\n`);
}

interface Candidate {
  name: string;
  options: BuildOptions;
  /** Anchor limit. Where the walk STARTS turned out to matter more than how far it goes. */
  limit?: number;
  /** Turn off the damping of common words. */
  rarityWeighting?: boolean;
}

/**
 * The first sweep varied only how far the walk goes, and barely moved recall
 * (50% at three hops, 41% at one). The per-case breakdown showed why: the
 * failures are not slightly-too-small boundaries, they are boundaries built in
 * the wrong part of the codebase, and all 30 cases hit the 12-anchor cap exactly.
 * A cap that binds every time is not a backstop, it is the selection rule — so
 * it belongs in the sweep.
 */
/**
 * Reachability was measured separately and is not the constraint: with no cap
 * and no damping, 83% of really-changed functions sit within ONE hop of an
 * anchor and 100% within three. So everything the boundary misses today is lost
 * by our own selection rules, not by the graph.
 *
 * That points the sweep at a different place than the plan assumed: fix WHERE
 * the walk starts, then walk LESS far. A shallow walk from good anchors should
 * beat a deep walk from poor ones on both recall and area at once.
 */
const CANDIDATES: Candidate[] = [
  { name: '12 anchors, depth 3 (today)', options: { maxDepth: 3 }, limit: 12 },
  { name: '60 anchors, depth 1', options: { maxDepth: 1 }, limit: 60 },
  { name: '60 anchors, no damping, depth 1', options: { maxDepth: 1 }, limit: 60, rarityWeighting: false },
  { name: '60 anchors, no damping, depth 2', options: { maxDepth: 2 }, limit: 60, rarityWeighting: false },
  { name: '60, no damping, no hubs, depth 1', options: { maxDepth: 1, hubRule: false }, limit: 60, rarityWeighting: false },
];

async function measure(repo: string): Promise<void> {
  const cases: TruthCase[] = JSON.parse(
    fs.readFileSync(path.join(CACHE, 'cases.json'), 'utf8'),
  );
  const facts = loadFacts(repo);
  if (!facts) throw new Error(`no graph facts for ${repo} — run \`ichor watch\` there first`);

  const present = new Set(facts.functions.map((f) => `${f.file}#${f.name}`));
  const total = facts.functions.length;
  const client = new GraphClient(configFromEnv());

  // Only cases whose changed code still exists can be scored.
  const usable = cases
    .map((c) => ({ ...c, changed: c.changed.filter((name) => present.has(name)) }))
    .filter((c) => c.changed.length > 0);

  const droppedCases = cases.length - usable.length;
  const droppedFunctions =
    cases.reduce((n, c) => n + c.changed.length, 0) -
    usable.reduce((n, c) => n + c.changed.length, 0);

  console.log(`\n  ${facts.functions.length} functions in the repo at HEAD`);
  console.log(
    `  ${usable.length} of ${cases.length} cases usable ` +
      `(${droppedCases} dropped whole, ${droppedFunctions} functions renamed or deleted since)\n`,
  );

  const results: { candidate: string; recall: number; median: number; worst: number; perfect: number }[] = [];

  for (const candidate of CANDIDATES) {
    const recalls: number[] = [];
    const sizes: number[] = [];
    let perfect = 0;

    for (const testCase of usable) {
      const { anchors, terms } = findAnchors(facts, testCase.task, {
        limit: candidate.limit,
        rarityWeighting: candidate.rarityWeighting,
      });
      const neighborhood = await buildNeighborhood(client, testCase.task, anchors, terms, candidate.options);

      const inside = new Set(
        [...neighborhood.members.values()].map((m) => `${m.file}#${m.name}`),
      );
      const hits = testCase.changed.filter((name) => inside.has(name)).length;
      const recall = hits / testCase.changed.length;

      recalls.push(recall);
      sizes.push(neighborhood.members.size / total);
      if (recall === 1) perfect++;
    }

    const mean = recalls.reduce((a, b) => a + b, 0) / recalls.length;
    const sorted = [...sizes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted[sorted.length - 1];

    results.push({ candidate: candidate.name, recall: mean, median, worst, perfect });
    const line =
      `  ${candidate.name.padEnd(34)} recall ${(mean * 100).toFixed(1).padStart(5)}%   ` +
      `median area ${(median * 100).toFixed(1).padStart(5)}%   ` +
      `worst ${(worst * 100).toFixed(1).padStart(5)}%   ` +
      `fully contained ${perfect}/${usable.length}`;
    console.log(line);
    // Written as each candidate finishes, so a long sweep can be watched rather
    // than waited out blind.
    fs.appendFileSync(path.join(CACHE, 'sweep.log'), `${line}\n`, 'utf8');
  }

  // The bar was fixed before any of this ran. See TASKS.md 1.5.
  console.log('\n  bar: recall >= 90%, median area < 5%');
  const passing = results.filter((r) => r.recall >= 0.9 && r.median < 0.05);
  if (passing.length === 0) {
    console.log('  NOTHING CLEARS THE BAR — report the number, do not move the bar.\n');
  } else {
    const best = passing.reduce((a, b) => (a.median <= b.median ? a : b));
    console.log(`  clears: ${passing.map((p) => p.candidate).join(', ')}`);
    console.log(`  smallest area among those: ${best.candidate}\n`);
  }

  await client.close();
}

/**
 * Per-case output for the current rules.
 *
 * An aggregate recall number says something is wrong but never what. This shows
 * whether the failure is spread evenly (the walk is shaped wrong) or concentrated
 * in a few cases (the anchors missed, and the boundary started in the wrong place).
 */
async function detail(repo: string): Promise<void> {
  const cases: TruthCase[] = JSON.parse(fs.readFileSync(path.join(CACHE, 'cases.json'), 'utf8'));
  const facts = loadFacts(repo);
  if (!facts) throw new Error(`no graph facts for ${repo}`);

  const present = new Set(facts.functions.map((f) => `${f.file}#${f.name}`));
  const client = new GraphClient(configFromEnv());
  const rows: { recall: number; line: string; missed: string[] }[] = [];

  for (const testCase of cases) {
    const truth = testCase.changed.filter((name) => present.has(name));
    if (truth.length === 0) continue;

    const { anchors, terms } = findAnchors(facts, testCase.task);
    const neighborhood = await buildNeighborhood(client, testCase.task, anchors, terms);
    const inside = new Set([...neighborhood.members.values()].map((m) => `${m.file}#${m.name}`));
    const missed = truth.filter((name) => !inside.has(name));
    const recall = (truth.length - missed.length) / truth.length;

    rows.push({
      recall,
      missed: missed.map((m) => m.split('#')[1]),
      line:
        `  ${(recall * 100).toFixed(0).padStart(3)}%  ` +
        `truth ${String(truth.length).padStart(2)}  ` +
        `area ${String(neighborhood.members.size).padStart(4)}  ` +
        `anchors ${String(anchors.length).padStart(2)}  ` +
        `${testCase.task.slice(0, 54)}`,
    });
  }

  for (const row of rows.sort((a, b) => a.recall - b.recall)) {
    console.log(row.line);
    if (row.recall < 1 && row.missed.length) {
      console.log(`         missed: ${row.missed.slice(0, 6).join(', ')}`);
    }
  }

  const zero = rows.filter((r) => r.recall === 0).length;
  console.log(`\n  ${zero} of ${rows.length} cases found NOTHING that really changed`);
  await client.close();
}

/**
 * The measurement that actually matters: would Ichor have INTERRUPTED this work?
 *
 * Whether a changed function sits in the member set is not that question, and
 * using it as a proxy overstated the harm badly. Ichor judges a FILE, and it
 * only speaks when the verdict is SUSPICIOUS or HUMAN_REVIEW — a file one hop
 * out that works on the task's data comes back CONNECTED and silent.
 *
 * So this replays every file of every real commit through the real classifier:
 *
 *   false alarm   a file the developer genuinely had to change, challenged
 *   silence       the rest — correct work, left alone
 *
 * A false-alarm rate is the number that decides whether anyone keeps this
 * installed, and it is the only recall-shaped number worth quoting.
 */
async function alarms(repo: string): Promise<void> {
  const cases: TruthCase[] = JSON.parse(fs.readFileSync(path.join(CACHE, 'cases.json'), 'utf8'));
  const facts = loadFacts(repo);
  if (!facts) throw new Error(`no graph facts for ${repo}`);

  const { classify, isChallenge } = await import('../src/scope/classify.js');
  const client = new GraphClient(configFromEnv());

  /**
   * Put the facts in the graph before asking the graph anything.
   *
   * This used to assume a populated database and never check. Run after a wipe it
   * measured every verdict against an EMPTY graph, where every file is "not in the
   * graph" — and reported **84.9% false alarms, 73 of them `file not in graph`**,
   * in exactly the confident shape a real result takes. Writing here costs a few
   * seconds and makes that failure impossible.
   */
  const { writeGraph } = await import('../src/graph/write.js');
  const written = await writeGraph(client, facts);
  console.log(
    `\n  graph: ${written.nodesWritten} nodes, ${written.edgesWritten} edges ` +
      `(${(written.durationMs / 1000).toFixed(1)}s)`,
  );

  for (const candidate of CANDIDATES) {
    let challenged = 0;
    let judged = 0;
    const byDecision = new Map<string, number>();
    const causes = new Map<string, number>();
    // Which FILE TYPES the false alarms land on. Ichor reads only TypeScript, so
    // this is what shows whether the number is dominated by files it cannot see.
    const byExt = new Map<string, { judged: number; challenged: number }>();
    const examples: string[] = [];

    for (const testCase of cases) {
      const files = testCase.files ?? [];
      if (files.length === 0) continue;

      const { anchors, terms } = findAnchors(facts, testCase.task, {
        limit: candidate.limit,
        rarityWeighting: candidate.rarityWeighting,
      });
      const neighborhood = await buildNeighborhood(client, testCase.task, anchors, terms, candidate.options);

      for (const file of files) {
        const verdict = await classify({ operation: 'edit', file }, { client, neighborhood, repo: repoIdFor(repo) });
        byDecision.set(verdict.decision, (byDecision.get(verdict.decision) ?? 0) + 1);
        judged++;

        const dot = file.lastIndexOf('.');
        const ext = dot === -1 ? '(none)' : file.slice(dot);
        const seen = byExt.get(ext) ?? { judged: 0, challenged: 0 };
        seen.judged++;
        const challenge = isChallenge(verdict);
        if (challenge) seen.challenged++;
        byExt.set(ext, seen);
        if (challenge) {
          challenged++;
          // Which BRANCH of the classifier spoke. Without this the total says
          // something is wrong but never which rule is wrong.
          const why = /is not in the graph/.test(verdict.reason)
            ? 'file not in graph'
            : /new and Ichor found no connection/.test(verdict.reason)
              ? 'new file, no connection'
              : /introduces a new/.test(verdict.reason)
                ? 'duplicate flow'
                : /reachable from the task only through/.test(verdict.reason)
                  ? 'reachable but works on other data'
                  : 'file outside the task entirely';
          causes.set(why, (causes.get(why) ?? 0) + 1);
          if (examples.length < 5) examples.push(`${file.slice(-52)}  <-  ${testCase.task.slice(0, 38)}`);
        }
      }
    }

    const spread = [...byDecision.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n}`).join('  ');
    console.log(
      `\n  ${candidate.name}\n` +
        `    false alarms ${challenged}/${judged} (${((challenged / judged) * 100).toFixed(1)}%) of real edits challenged\n` +
        `    ${spread}`,
    );
    for (const [cause, n] of [...causes.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(n).padStart(3)}  ${cause}`);
    }
    const worst = [...byExt.entries()]
      .filter(([, v]) => v.challenged > 0)
      .sort((a, b) => b[1].challenged - a[1].challenged);
    if (worst.length) {
      console.log(`      by file type:`);
      for (const [ext, v] of worst) {
        console.log(`        ${ext.padEnd(8)} ${v.challenged}/${v.judged} challenged`);
      }
    }
    for (const example of examples) console.log(`      would have asked about: ${example}`);
  }

  await client.close();
}

const [mode, repoArg] = process.argv.slice(2);
const repo = path.resolve(repoArg ?? '.');

if (mode === 'collect') collect(repo);
else if (mode === 'measure') await measure(repo);
else if (mode === 'detail') await detail(repo);
else if (mode === 'alarms') await alarms(repo);
else {
  console.log('usage: ground-truth.ts collect|measure|detail|alarms <repo>');
  process.exit(1);
}
