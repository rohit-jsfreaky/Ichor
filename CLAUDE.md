# Ichor — working agreement

Read this before changing anything. It exists so a fresh session does not undo a decision made carefully.

## What this is

**Ichor makes scope expansion explicit while AI coding agents work.**

A developer gives Claude Code or Codex a task. Ichor works out which part of the codebase the task genuinely belongs to, watches every edit, stays silent while the work belongs to the task, and challenges the agent when it expands somewhere it cannot justify.

The central question: **"Are you still solving the task I was given?"**

Built for **Hack Hydra** Track 02, solo. **Deadline Thu 21 Aug 2026, 12:29 PM IST.**

| Doc | What |
|---|---|
| `PROJECT_FINAL.md` | Full product thesis — the source of truth for *what Ichor is* |
| `SCOPE.md` | The buildable subset, the skip list, the day plan |
| `docs/ENGINEERING-RULES.md` | How to write the code |

Research lives at `D:\my_projects\portfolio\hack-hydra\`.

## The rules that must not be broken

1. **Every edge traceable to source.** No LLM decides code structure — that comes from the TypeScript compiler. The LLM Judge reasons about *intent*, never about what calls what.
2. **Silence is the default.** False positives kill this product. Challenge only what is clearly outside the neighbourhood; when uncertain, say nothing.
3. **Every warning carries evidence.** Never "suspicious file". Always the path, or the existing path that already solves it.
4. **Graph first, LLM second.** Obvious cases never reach the Judge (`PROJECT_FINAL.md` §66).
5. **Honour the skip list in `SCOPE.md`.** It was decided calmly so it survives 2am on day 5.

## The two tests — the core of the product

```
TEST 1 — is the edit connected to the task?           graph reachability
TEST 2 — does an existing path already do this?       the new-flow test
```

Test 2 is what catches the demo case. `/api/vendors/check-email` **passes** test 1 — it imports Prisma, looks up a vendor by email, sits under the vendor routes. It is wrong because the existing submit path already reaches the uniqueness check. **If you only implement test 1, the demo fails.**

## Design decisions you will otherwise undo

- **Symbol-level, not file-level.** One file can hold forty functions with one in the task.
- **New files are classified by what they reach**, not by being new. The hook carries the pending content — parse it, resolve its imports and calls against the graph.
- **The hook's parse is a HINT, never a graph edge.** It resolves by name, not through the
  type checker, so it may corroborate connectivity but must never be written into the graph or
  quoted as evidence (rule 1). Freshness comes from rebuilding between turns instead: `Stop`
  spawns a detached rebuild, because analysis costs ~1.6s on the demo and ~2.8s here.
- **The task boundary goes stale faster than the graph.** People work all day in one
  conversation, so `UserPromptSubmit` re-reads the boundary from each prompt and redraws it
  when the job changes. Ambiguity always resolves to "change nothing".
- **One hook script serves both agents.** Claude Code and Codex accept the identical `PreToolUse` JSON; only the config path differs.

## Hard constraints you will otherwise trip over

**HydraDB is a Cypher *subset*.** Rejected at parse time: `IN`, `CONTAINS`, `ENDS WITH`, `IS NULL`, `min`, `max`, `RETURN *`, undirected patterns, more than one relationship type per pattern, unbounded `*`, `WITH` that aliases or filters, more than one statement per request. Whole paths / multiple rel types / undirected traversal must go through `algo.SPpaths` / `SSpaths` / `MSpaths`. **`pathCount` truncates silently** — set it high and verify.

**Node ids are non-negative integers**, produced only by `src/ids.ts`, stable across runs and machines.

**Storage is MinIO**, `CLOUD_PROVIDER=aws` + `AWS_ENDPOINT`. `CLOUD_PROVIDER=local` cannot sustain writes.

**Batch writes over Bolt** with `UNWIND $rows`. ~200 writes/sec and they serialise.

**HydraDB runs locally on the user's machine.** Their code never leaves it. This is a feature, not a limitation.

## Never

- Commit or push. **Rohit does all git operations himself.**
- Copy code from Graphify or any prior work — start-date and licensing violation.
- Commit `.env` or any key.
- Widen scope. Write it in `SCOPE.md` and move on.

## Layout

```
src/ids.ts              string -> stable integer id  (LOAD-BEARING, one owner)
src/graph/client.ts     the only place we talk to HydraDB
src/extract/            ts-morph -> functions, calls, routes, prisma, tests
src/scope/              task neighbourhood + the two tests
src/hook/               PreToolUse handler shared by Claude Code and Codex
src/mcp/                MCP server the agent talks to
src/cli.ts              init / start / status
demo/                   Next.js + Prisma app carrying the vendor bug
web/                    static landing page
scripts/smoke.ts        proves HydraDB is writable and returns whole paths
```

## Commands

```bash
npm run up        # MinIO + HydraDB
npm run smoke     # a listening port is not proof; a round-tripped write is
npm run typecheck
npm test
```

## Current state

**Feature-complete, verified live on both agents.** Analyzer, graph, scope engine, hooks
(`PreToolUse` / `UserPromptSubmit` / `Stop`), MCP server with seven tools, Judge, landing page,
and the turn-boundary refresh are all built. Remaining: the 3-minute video, making the repo
public, and publishing to npm.

Superseded: the original "which endpoint can reach sensitive data" product. The graph work carries over; the thesis does not (`PROJECT_FINAL.md` §24).
