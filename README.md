<img src="web/icon.svg" width="48" height="48" alt="" />

# Ichor

**You asked for three files. It changed twenty.**

Ichor watches your coding agent while it works and challenges it the moment it goes past the job you gave it — with the path it can point at.

```
you    › Duplicate email in vendor onboarding returns 500. Handle it properly,
         show a toast saying the email already exists, and don't wipe the form.

claude › editing src/lib/vendors/create.ts       ✓ ichor: in scope
claude › editing src/app/api/vendors/route.ts    ✓ ichor: in scope
claude › editing src/lib/vendors/submit.ts       ✓ ichor: in scope
claude › creating src/app/api/vendors/check-email/route.ts

⚠ ichor: this looks like scope expansion.

  src/app/api/vendors/check-email/route.ts introduces a new POST endpoint at
  /api/vendors/check-email that reaches Vendor, but the task's existing path
  already reaches it:

    POST /api/vendors → createVendor → Vendor.email (unique)

  Why is a separate POST endpoint required?

claude › It isn't. I'll handle the duplicate in the existing submit flow.

result › 3 files changed. 0 new endpoints. Task done.
```

That is not a mock-up. It is the literal output of `ichor hook` against the demo app in this repository, reproducible in about five minutes.

**There is no task to type.** Ichor takes the job from what you already said to your agent, and moves it when you move on.

```bash
npm i -g ichor-cli
cd your-repo && ichor init && ichor up && ichor watch
```

Needs Node 20+, Docker, and a TypeScript or JavaScript repo. Full reference: [`web/docs.html`](web/docs.html).

> Built for [Hack Hydra](https://hackhydra.hydradb.com/) 2026 · Track 02 · solo.
> Reviewing this? [**How the code is laid out**](#how-the-code-is-laid-out) and [**Verify it yourself**](#verify-it-yourself) are written for you.

---

## In one page

| | |
|---|---|
| **What it does** | Judges every edit your agent is about to write against the job you asked for |
| **How** | A compiled graph of your codebase — what calls what, which endpoints reach which tables — kept in a local [HydraDB](https://github.com/hydra-db/hydradb) |
| **When** | Before the write lands for an edit tool; the instant the command finishes for a shell write. `PreToolUse` + `PostToolUse`. Not a linter, not a review bot |
| **Cost of being wrong** | It questions about **one edit in eight** that you were right to make. Measured on somebody else's repo, not estimated |
| **Needs a key?** | No. A key adds one thing: weighing an agent's *argument* when the graph alone cannot settle it |
| **Blocks anything?** | Never. It asks once per file, and takes your answer |

---

## How it decides

A task is almost never one folder. *"Change invite expiry from 24 to 48 hours"* can live across a page, an action, a service, a token helper, a config constant, a database model and a test — files sharing no vocabulary and no directory.

So the boundary cannot be `src/vendors/**`, and it cannot be "files that read like the task description" either. The only thing that actually connects those files is the structure of the program.

**Test 1 · Is this edit connected to the task?** Ichor anchors your words to real routes, functions and model fields, then follows actual call structure outward. A new file is judged by what it *reaches*, never by being new — real work creates files constantly.

**Test 2 · Does an existing path already do this?** The harder one, and the reason a graph is needed rather than a search.

```
the task's existing path:
   POST /api/vendors ────► createVendor ────► Vendor.email  (unique)
                                                   ▲
   the new endpoint:                               │
   POST /api/vendors/check-email ──────────────────┘
        reaches the SAME rule by a SECOND road
```

Ask any search tool whether `/api/vendors/check-email` relates to a duplicate-email fix and everything says yes: same table, same folder, same service. All true — so relatedness gives you no reason to object. But the database already refuses duplicate emails and the submit path already reaches that rule, so the endpoint is connected, relevant, and **unnecessary**. That is the judgement no amount of retrieval can make for you.

**Structure is never decided by a model.** Every edge comes from the TypeScript compiler: `import { send } from './email'` plus that module's export list *is* the answer, followed through re-exports, namespace imports and default exports — never a same-name coincidence, never a hit inside a comment or a string. What a model is used for is one question, only when an agent *argues* an expansion is necessary: is that argument supported by the evidence the graph produced? With no key, an argument Ichor cannot verify comes to you instead of being granted. A real captured run is in [`docs/JUDGE-TRANSCRIPT.md`](docs/JUDGE-TRANSCRIPT.md), including the case where it refuses to fold to an argument citing OWASP.

And it reports what it could not resolve: on papermark, **7,178 call sites did not resolve** to a declaration, counted rather than guessed at. The graph is a floor, never an inflated one — every edge in it can be quoted back to an agent as the reason its edit was questioned, and evidence that might be wrong is worse than no evidence.

---

## Does it actually work?

A tool that questions correct work gets uninstalled the same afternoon. So that is the thing worth measuring — and passing tests on a toy demo says nothing about it.

Ichor was measured against **30 real commits** from [papermark](https://github.com/mfts/papermark), a real document-sharing product. Every commit is a labelled example: its message is the task, the files it changed are what a developer genuinely had to touch. Each was replayed through the real classifier.

| | |
|---|---|
| **real edits wrongly challenged** | **12.8%** |
| real changed code inside the boundary | 68.4% |
| median task area | 8.9% of the repo |
| worst-case task area | 12.1% |

By file type: `.ts` 10 of 45 · `.tsx` **1 of 26** · `.prisma` **0 of 2** · everything else **0**.

Scope of the claim: one repository, 30 commits, 86 changed files of every type, TypeScript.

| | papermark (1,362 files) | Infisical (7,735 files) |
|---|---|---|
| first index, empty database | ~19s | 2m 21s |
| second index, nothing changed | **6s** | **16s** |
| peak memory | under 400 MB | under 800 MB |

Both at Node's default heap — there is no `--max-old-space-size` anywhere in this repository. Every number here, the command that produces it, and how recently it was checked are in [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md).

---

## What your agent can ask it

The same graph that judges edits answers questions, so your agent stops guessing at grep patterns — as nine MCP tools, and as plain shell commands.

```bash
ichor find "where uploads are retried"   # structure, not a grep guess
ichor impact uploadFileToR2              # callers, routes, tables at stake
ichor paths Vendor                       # how a table is actually reached
ichor check lib/api/uploads.ts           # is this file in the current job?
ichor justify <file> "<reason>"          # argue back, and have it weighed
```

Same graph, same answers, one implementation — the CLI dispatches into the same function the MCP server does. Asked *"what breaks if I delete the useAuth hook?"* on a real project, a live agent answered with **one `ichor_impact` call and nothing else** — no grep, no file reads.

The second door exists because of a measurement. Claude Code injects "search with grep and find" into auto-mode turns for some models, and counted across one repository's sessions, every turn carrying that instruction used Ichor's tools **zero** times — while every turn without it used them freely. Ichor was losing an argument with a platform instruction that arrives every turn from the system position. So it stopped arguing: the instruction says reach for the shell, and these are the shell.

---

## How the code is laid out

14,030 lines of TypeScript across 36 files. Every module has a header comment explaining what it owns and, where relevant, what was measured to arrive at its design.

| Directory | Lines | What it owns |
|---|---|---|
| `src/scope/` | 3,461 | The decisions. Anchoring a task to real symbols, walking the neighbourhood, classifying an edit, detecting a task switch |
| `src/extract/` | 2,654 | Reading a repo with the TypeScript compiler into facts: functions, calls, routes, types, Prisma models. Incremental re-reads |
| `src/hook/` | 2,347 | The agent-facing surface: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, and installing into Claude Code and Codex |
| `src/graph/` | 1,514 | HydraDB over Bolt, delta writes, and the queries behind every verdict |
| `src/stack/` | 804 | The local HydraDB and MinIO stack |
| `src/mcp/` | 800 | Nine tools over stdio, so the agent can use the graph rather than only be judged by it |
| `src/judge/` | 605 | The optional model call, and only for weighing an argument |
| `src/refresh/` | 413 | Rebuilding between turns, detached, when nobody is waiting |

**Where to start reading:** `src/scope/classify.ts` is the verdict, `src/scope/anchors.ts` is how a sentence becomes a set of graph nodes, and `src/graph/write.ts` is where most of the engine-specific pain lives.

The rules the code is held to are in [`docs/ENGINEERING-RULES.md`](docs/ENGINEERING-RULES.md) — *structure is compiler-truth*, *silence is a feature*, *one owner per load-bearing decision*, *never fail silently*.

---

## Verify it yourself

This repository contains a small Next.js + Prisma vendor app with the duplicate-email bug already in it.

```bash
git clone https://github.com/rohit-jsfreaky/ichor && cd ichor
npm install
npm run up                    # HydraDB + MinIO via Docker
npm run smoke                 # round-trips a real write; a listening port is not proof
npm run build

npm test                      # 244 unit tests
npm run check                 # 10 classification scenarios, incl. a mid-session job switch
npm run session:test          # 12 cases a real session hits and nothing else tested
npm run mcp:test              # 20 MCP protocol checks
npm run hook:test             # 6 hook cases, spawning the real CLI as an agent would
npm run multi:test            # 10 checks that two projects never bleed into each other
npm run incremental:test      # 5 checks that a partial re-read equals a full one
npm run read:test  -- <repo>  # can it read a real codebase at the default heap?
npm run delta:test -- <repo>  # does the graph match the code after a write?
npm run named:gate -- <repo>  # does naming a file narrow scope, and change nothing else?
```

**Two of those exist as a direct result of being wrong.**

`npm run session:test` exists because the suites above it **all passed while eleven real bugs were live** — every one of them ran against an eleven-file demo. This drives the real compiled hook over real payloads: a file type Ichor cannot read, a path in no repository, a question instead of an instruction, a rebuild holding the database.

`npm run check` is the one to read. It runs the vendor task, then **switches job mid-session** to billing: the billing file that was `SUSPICIOUS` under the first task must now be `EXPECTED`, and the vendor code that was in scope must not be. That flip is the whole point of a boundary that follows the conversation.

[`demo/EXPECTED-GRAPH.md`](demo/EXPECTED-GRAPH.md) is the graph hand-derived from the source **before** the analyzer was written, so the analyzer could not be quietly bent to match its own output.

---

## Supported agents

| Agent | Level | How |
|---|---|---|
| **Claude Code** | Full | `PreToolUse` hook — challenges *before* the edit is written |
| **Codex CLI** | Full | Same mechanism, same decisions |
| Cursor · Windsurf · Gemini CLI · Cline | Coming | Same adapter interface |

---

## What it cannot do

- **TypeScript and JavaScript only.** Python is next. Nothing else is claimed.
- **It questions about one edit in eight that you were right to make.** Naming the file in your prompt is what makes the boundary precise — on a real project that was 135 functions of guesswork down to the 9 in the file named.
- **It understands one stack deeply.** Next.js App Router routes and Prisma models are what it reads. Pages Router routes and other ORMs are not in the graph yet, so on those codebases Ichor sees the calls but not the endpoints or the tables — and `ichor paths` says it has nothing rather than guessing.
- **In a monorepo, cross-package calls are missed.** An import of `your-pkg/api` resolves through a `package.json` `exports` map and a workspace link, which name-and-import-path resolution does not follow. On better-auth, `ichor impact createAuthEndpoint` reports *"called by nothing in the graph"* where the source has **304 call sites across 10 packages**. Within a package it is accurate; treat a monorepo answer as a floor.
- **A shell write is challenged after it lands, not before.** An agent editing with `sed` or a heredoc fires no `PreToolUse` hook, so Ichor reads what changed on disk once the command finishes and asks then. The bytes are written by the time the question is asked; what is preserved is that nothing has been built on top of them yet.
- **Ichor can be wrong.** The boundary is an expectation, not a fact, and it is designed to grow when the work justifies it. When it cannot verify a justification it asks you rather than deciding.

Static-analysis blind spots, memory ceilings, one-database-per-repo and the rest are in [`web/docs.html`](web/docs.html).

---

## Your code never leaves your machine

HydraDB and MinIO run locally through Docker. The graph of your codebase stays on your disk, every port binds to `127.0.0.1`, and there is no account and no telemetry.

The only outbound request Ichor can make is to OpenRouter, only if you set a key, and only carrying the task description, the file path, and paths the graph already found.

---

## Credits

Built on [HydraDB](https://github.com/hydra-db/hydradb), an object-store-native graph database, for [Hack Hydra](https://hackhydra.hydradb.com/) 2026. Ichor stores your code graph in a local HydraDB instance — delete it and there is no product.

Licensed [MIT](LICENSE).
