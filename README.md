<img src="web/icon.svg" width="48" height="48" alt="" />

# Ichor

**You asked for three files. It changed twenty.**

Ichor watches your coding agent as it works, catches unnecessary scope expansion, and challenges it before a small fix turns into a twenty-file mess.

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

    POST /api/vendors → POST → createVendor → Vendor

  The existing POST /api/vendors already reaches Vendor, where Vendor.email is
  already unique. Why is a separate POST endpoint required?

claude › It isn't. I'll handle the duplicate in the existing submit flow.

result › 3 files changed. 0 new endpoints. Task done.
```

That is not a mock-up. It is the literal output of `ichor hook` against the demo app in this repository, reproducible in about five minutes.

**There is no task to type.** Ichor takes the job from what you already said to your agent, and moves it when you move on.

> Built for [Hack Hydra](https://hackhydra.hydradb.com/) 2026 · Track 02 · solo.
> Reading this to review the project? [**How the code is laid out**](#how-the-code-is-laid-out) and [**Verify it yourself**](#verify-it-yourself) are the two sections written for you.

---

## In one page

| | |
|---|---|
| **What it does** | Judges every edit your agent is about to write against the job you asked for |
| **How** | A compiled graph of your codebase — what calls what, which endpoints reach which tables — kept in [HydraDB](https://github.com/hydra-db/hydradb) |
| **When** | Before the write lands, as a `PreToolUse` hook. Not a linter, not a review bot |
| **Cost of being wrong** | It questions about **one edit in eight** that you were right to make. Measured on somebody else's repo, not estimated |
| **Needs a key?** | No. A key adds one thing: weighing an agent's *argument* when the graph alone cannot settle it |
| **Blocks anything?** | Never. It asks once per file, and takes your answer |

**Install:** `npm i -g ichor-cli`, then `ichor init && ichor up && ichor watch`. Full reference in [`web/docs.html`](web/docs.html).

---

## It is not a code graph. It uses one.

Ichor keeps a graph, but the graph is not the product — it is the **evidence**. That distinction is the whole project, so it is worth being precise about.

| | A code graph | Ichor |
|---|---|---|
| **The question** | Where is this? What relates to it? | Should *this* edit be part of *this* job? |
| **When it runs** | When the agent chooses to ask | Every write, whether it asks or not — before the file exists |
| **Knows today's task** | No | Yes. Read from your prompt, moved when you move on |
| **Breadth** | ~40 languages, docs and PDFs too | TypeScript and JavaScript only |
| **Output** | Results you interpret | A verdict, with a path it can point at |

Tools like [Graphify](https://github.com/Graphify-Labs/graphify) map a codebase so you can **query it instead of grepping**. You ask, it answers, you decide. They are good at that, they cover far more ground than Ichor ever will, and Ichor is not trying to be one. **You could reasonably run both.**

### Names are bound, not matched

A search tool finds the string `send`. Ichor works out *which* `send`.

`import { send } from './email'` plus that module's export list **is** the answer — so a call becomes an edge to a declaration Ichor can name, followed through re-exports, namespace imports and default exports. Never a same-name coincidence in an unrelated file, and never a hit inside a comment or a string literal.

It deliberately does **not** use TypeScript's type checker to do this, and that was a measurement rather than a shortcut. Asking the checker "which function is this?" costs ~2.45ms per call site, and a real repository has ~16,300 that need resolving — about forty seconds. Of the calls that actually become an edge, **96.5%** are a plain `send(x)`, 1% are `this.foo()`, and only **2.5%** are `obj.method()` on a value whose type only the checker knows. Forty seconds for 2.5% is a bad trade; the other 97.5% needs no inference at all, just bookkeeping.

### And it reports what it could not resolve

On papermark, **7,178 call sites did not resolve** to a declaration. They are counted and reported, not guessed at.

That number is in the product on purpose. The graph is a **floor**, never an inflated one — because every edge in it can be quoted back to an agent as the reason its edit was questioned, and evidence that might be wrong is worse than no evidence. `npm run delta:test -- <repo>` checks the written graph against the code, per relationship type, for the same reason.

---

## How it decides

A task is almost never one folder. *"Change invite expiry from 24 to 48 hours"* can live across a page, an action, a service, a token helper, a config constant, a database model and a test — files sharing no vocabulary and no directory.

So the boundary cannot be `src/vendors/**`, and it cannot be "files that read like the task description" either. The only thing that actually connects those files is the structure of the program: which function calls which, which route is handled by what, which function touches which table.

Two tests, in order:

**1 · Is this edit connected to the task?** Ichor anchors your words to real routes, functions and model fields, then follows actual call structure outward. A new file is judged by what it *reaches*, never by being new — real work creates files constantly.

**2 · Does an existing path already do this?** The harder one, and the reason a graph is needed rather than a search.

### Connected is not the same as necessary

Your agent adds `/api/vendors/check-email` during a duplicate-email fix. Ask any search tool whether it relates to the task and everything says yes: same table, same folder, same service. All true — so relatedness gives you no reason to object.

Ichor asks the next question:

```
the task's existing path:
   POST /api/vendors ────► createVendor ────► Vendor.email  (unique)
                                                   ▲
   the new endpoint:                               │
   POST /api/vendors/check-email ──────────────────┘
        reaches the SAME rule by a SECOND road
```

The database already refuses duplicate emails, and the submit path already reaches that rule. So the endpoint is connected, relevant, and **unnecessary** — a second enforcement of something already enforced. That is the judgement no amount of retrieval can make for you.

When an agent *argues* that an expansion is genuinely necessary, one model is asked one question: is that argument supported by the evidence the graph produced? **Structure is never decided by a model.** With no key, an argument Ichor cannot verify comes to you instead of being granted.

This is the only part that needs an API key, so a real captured run of it is in [`docs/JUDGE-TRANSCRIPT.md`](docs/JUDGE-TRANSCRIPT.md) — including the case where it refuses to fold to an argument citing OWASP, and the case where it declines to rule on a claim a call graph cannot see.

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

Scope of the claim: one repository, 30 commits, 86 changed files of every type, TypeScript. Reproduce with `npx tsx scripts/ground-truth.ts collect <repo>` then `alarms <repo>`.

### Speed and memory

| | papermark (1,362 files) | Infisical (7,735 files) |
|---|---|---|
| first index, empty database | ~19s | 2m 21s |
| second index, nothing changed | **6s** | **16s** |
| peak memory | under 400 MB | under 800 MB |

Both at Node's default heap — there is no `--max-old-space-size` anywhere in this repository. `npm run read:test -- <repo>` answers "can Ichor read my codebase" before you install anything. Timings are wall clock on one machine and published as approximations for that reason; every number in this README, the command that produces it, and how recently it was checked are in [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md).

Refreshes re-read only what changed, and `npm run incremental:test` asserts an incremental read is **identical** to a full one, because a stale graph never announces itself. `npm run delta:test -- <repo>` checks the written graph against the code per relationship type — papermark is 3,471 functions and **21,384** connections — because a fast write and a correct one are different things.

---

## What your agent can ask it

The same graph that judges edits will answer questions, so your agent stops guessing at grep patterns.

| Tool | Answers |
|---|---|
| `ichor_find` | Where does X live? Described in plain words — it searches structure, so it finds names you could not have guessed |
| `ichor_impact` | What breaks if I change this? Callers, the endpoints that reach it, tables at stake, and every function depending on a type's shape |
| `ichor_paths` | How does the app reach this table, through which functions? No file search can answer this |
| `ichor_check_change` | Is this file in the current job, before I edit it? |

Five more cover scope, evidence and requesting an expansion. Asked *"what breaks if I delete the useAuth hook?"* on a real project, a live agent answered with **one `ichor_impact` call and nothing else** — no grep, no file reads.

Ichor names these in the context it injects each turn, because a tool description alone does not reach an agent: hosts defer MCP schemas when several servers are connected, and an unnamed tool is one the agent never sees.

---

## How the code is laid out

11,638 lines of TypeScript across 31 files. Every module has a header comment explaining what it owns and, where relevant, what was measured to arrive at its design.

| Directory | Lines | What it owns |
|---|---|---|
| `src/extract/` | 2,589 | Reading a repo with the TypeScript compiler into facts: functions, calls, routes, types, Prisma models. Incremental re-reads |
| `src/scope/` | 2,997 | The decisions. Anchoring a task to real symbols, walking the neighbourhood, classifying an edit, detecting a task switch |
| `src/hook/` | 1,578 | The agent-facing surface: `PreToolUse`, `UserPromptSubmit`, `Stop`, and installing into Claude Code and Codex |
| `src/graph/` | 1,421 | HydraDB over Bolt, delta writes, and the queries behind every verdict |
| `src/mcp/` | 758 | Nine tools over stdio, so the agent can use the graph rather than only be judged by it |
| `src/judge/` | 605 | The optional model call, and only for weighing an argument |
| `src/refresh/` | 350 | Rebuilding between turns, detached, when nobody is waiting |
| `src/stack/` | 401 | The local HydraDB and MinIO stack |

**Where to start reading:** `src/scope/classify.ts` is the verdict, `src/scope/anchors.ts` is how a sentence becomes a set of graph nodes, and `src/graph/write.ts` is where most of the engine-specific pain lives.

**The rules the code is held to** are in [`docs/ENGINEERING-RULES.md`](docs/ENGINEERING-RULES.md) — four of them, including *structure is compiler-truth*, *silence is a feature* and *never fail silently*. Where a design choice looks odd, the module header usually says what was measured to arrive at it; `src/extract/symbols.ts` and `src/graph/write.ts` are the two worth reading for that.

---

## Verify it yourself

This repository contains a small Next.js + Prisma vendor app with the duplicate-email bug already in it.

```bash
git clone https://github.com/rohit-jsfreaky/ichor && cd ichor
npm install
npm run up                    # HydraDB + MinIO via Docker
npm run smoke                 # round-trips a real write; a listening port is not proof
npm run build

npm test                      # 178 unit tests
npm run check                 # 10 classification scenarios, incl. a mid-session job switch
npm run session:test          # 12 cases a real session hits and nothing else tested
npm run mcp:test              # 20 MCP protocol checks
npm run hook:test             # 6 hook cases, spawning the real CLI as an agent would
npm run multi:test            # 10 checks that two projects never bleed into each other
npm run incremental:test      # 5 checks that a partial re-read equals a full one
npm run read:test -- <repo>   # can it read a real codebase at the default heap?
npm run delta:test -- <repo>  # does the graph match the code after a write?
npm run named:gate -- <repo>  # does naming a file narrow scope, and change nothing else?
npm run judge:test            # a live Judge, three cases, a few cents
```

**Three of those are worth understanding**, because they exist as a direct result of being wrong:

`npm run session:test` exists because the six suites above it **all passed while eleven real bugs were live** — every one of them ran against an eleven-file demo. This drives the real compiled hook over real payloads: a file type Ichor cannot read, a path in no repository, a question instead of an instruction, a rebuild holding the database.

`npm run named:gate` shows what a gate is *for*. It asserts naming a file narrows the boundary **and** that a prompt naming nothing produces a byte-identical answer — including for all 30 commits the published 12.8% is measured on. The first half is the feature; the second is proof that shipping it did not silently invalidate the number.

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
- **A shell write cannot be challenged.** Ichor hooks edit tools, so a file written by `cat >`, a codegen script or your own editor is invisible in the moment. It is named at the end of the turn instead, so silence never means "nobody looked".
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
