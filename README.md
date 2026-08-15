# Ichor

**Make every scope expansion explicit while AI coding agents work.**

You ask Claude for a small fix. It starts correctly. Then it adds an endpoint, introduces an abstraction, refactors a helper, touches authentication, rewrites a test — and twenty files later you are reviewing a change you never asked for.

Ichor notices that **while the agent is still working**.

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

That challenge is not a mock-up. It is the literal output of `ichor hook` against the demo app in this repository, and you can reproduce it in about five minutes — see [Verify it yourself](#verify-it-yourself).

> Built for [Hack Hydra](https://hackhydra.hydradb.com/) 2026 · Track 02 · solo.

---

## Why this needs a graph

A task is almost never one file. *"Change invite expiry from 24 to 48 hours"* might live across an invite page, an action, a service, a token helper, a config constant, a database model and a test — files that share no vocabulary and no folder.

So the boundary cannot be `src/vendors/**`, and it cannot be "files that look similar to the task description" either. The only thing that actually connects those files is **the structure of the program**: which function calls which, which route is handled by what, which function touches which database model.

That structure is a graph, so Ichor keeps it in [HydraDB](https://github.com/hydra-db/hydradb) and reasons over the connected neighbourhood of the task.

**The graph is not the product. It is the evidence.** Every sentence Ichor shows an agent is a path it can point at.

## How it decides

Two independent tests, in order.

### Test 1 — is this edit connected to the task?

Reachability from the task neighbourhood. Ichor anchors the task text to real routes, functions and model fields, then walks outward through actual call structure. A new file is judged by what it *reaches*, never by the fact that it is new — real work creates new files constantly.

### Test 2 — does an existing path already do this?

The interesting half, and the one nothing else does.

A new `/check-email` endpoint **is** connected. It imports Prisma, looks up a vendor by email, sits with the other vendor routes. Every connectedness check passes. It is still the wrong change, because the existing submit path already reaches the same model, where `email` is already `@unique`. It is a second door into a room that already had one.

No permission system, linter, or diff review catches that. It needs the graph.

## Not a blocker

Ichor is not a file fence. Edits are classified as:

| | |
|---|---|
| **EXPECTED** | inside the neighbourhood — silent |
| **CONNECTED** | just outside, real path back, same data — expand automatically, silent |
| **SUSPICIOUS** | weak or no connection — ask the agent why, and show the evidence |
| **JUSTIFIED** | the agent explained and the codebase backs it up — the boundary grows |
| **HUMAN REVIEW** | plausible but unverifiable — your call, not Ichor's |

**Silence is the normal state.** A tool that fires on every third edit gets uninstalled the same afternoon. Ichor also asks **once per file** — it states its case and then gets out of the way.

When an agent clears a challenge by simply writing the file again rather than explaining, that is allowed — Ichor is not a blocker — but it is **remembered**. Forced files show up in `ichor status` and are never cited as an "existing path" against some later change, so a bypassed challenge cannot become tomorrow's precedent.

## The boundary follows the conversation

Nobody runs a CLI command between tasks. People work all day in one Claude Code or Codex session, and a boundary drawn for the 9am task spends the afternoon challenging every edit of a different one. At that point Ichor is not a safety net — it is the thing you turn off.

So the boundary moves with you:

```
you  › fix the duplicate email crash in vendor onboarding
  [ichor] task set — 14 functions, data: Vendor

you  › continue
  [ichor] nothing changes — that names no part of the codebase

···  hours later, same conversation  ···

you  › now fix the rounding on billing invoices
  [ichor] new task — 3 functions, data: Invoice
```

Every prompt is classified against a cached index of every name in the repo:

| | |
|---|---|
| **NO SIGNAL** | names nothing in the codebase — change nothing |
| **SAME** | points inside the boundary — carry on |
| **WIDENED** | points inside *and* somewhere new — grow, keep the challenge history |
| **NEW** | points only outside — redraw, and forget what was already asked |

The bias runs one way: anything ambiguous resolves to **NO SIGNAL**, which changes nothing. "Continue", "that didn't work", a question, a pasted stack trace, a prompt in another language — none of them move a boundary. Detection is pure string work against a cached index, so it costs a file read and no analysis.

Two more things happen around the turn:

- **The graph rebuilds when the agent stops talking**, in a detached process, because you are reading the answer and nobody is waiting. Measured at ~1.6s on the demo and ~2.8s on this repo — it could never run on a keystroke.
- **The agent is told the boundary before it starts.** Each turn opens with what is in scope and what data the task is about, so over-reach is mostly prevented rather than punished.

`ichor start "…"` still names a task by hand. That sets `mode: explicit`, and detection then reports a job change without redrawing a boundary you chose yourself.

## Quick start

```bash
npm i -g ichor-cli

cd your-repo
ichor init     # installs hooks + MCP, writes the HydraDB stack
ichor up       # starts HydraDB and MinIO locally
ichor watch    # reads the codebase and starts following the conversation
```

Then run Claude Code or Codex exactly as you normally would. **There is no task to type.** Ichor takes it from what you ask the agent:

```
> fix the duplicate email crash in vendor onboarding
  [ichor] task set — 14 functions, data: Vendor

  …hours later, same conversation…

> now fix the rounding on billing invoices
  [ichor] new task — 3 functions, data: Invoice
```

That matters more than it looks. Nobody runs a CLI command between tasks, so a boundary you set at 9am is still policing vendor code at 2pm while you are deep in billing — challenging every edit until you turn the thing off.

```bash
ichor status      # what is in scope, what was challenged, what was forced through
ichor start "…"   # name the task by hand instead; detection then reports but never redraws
ichor stop        # stop watching
ichor down        # stop the database   (--wipe also deletes the graph)
```

**Requirements:** Node 20+, Docker, and a TypeScript repo — ideally Next.js with Prisma.

`ichor init` writes `docker-compose.ichor.yml` into your repo and adds `.ichor/` to your `.gitignore`. It merges into existing `.claude/settings.json`, `.codex/hooks.json` and `.mcp.json` rather than overwriting them — clobbering somebody's hook config would be a poor introduction for a tool that installs itself.

## Verify it yourself

This repository contains a small Next.js + Prisma vendor onboarding app with the duplicate-email bug already in it, and the full test suite runs against it.

```bash
git clone https://github.com/rohit-jsfreaky/ichor && cd ichor
npm install
npm run up          # HydraDB + MinIO via Docker
npm run smoke       # a listening port is not proof — this round-trips a real write
npm run build

npm test            # 89 unit tests
npm run check       # 10 classification scenarios, including a mid-session job switch
npm run hook:test   # 6 hook cases, spawning the real CLI as an agent would
npm run mcp:test    # 13 MCP protocol checks
npm run judge:test  # 3 live Judge cases (needs an OpenRouter key; skips without one)
```

To watch it work on the demo app:

```bash
node dist/src/cli.js start "fix duplicate email handling in vendor onboarding" --repo ./demo
```

```
  reading the codebase… 17 functions, 10 calls, 2 routes
  finding the task area… 13 functions

Data this task is about: Vendor

Watching. Run your agent as usual.
```

`npm run check` is the one to read. It runs the vendor task, then **switches job mid-session** to billing and re-runs two edits: the billing file that was SUSPICIOUS under the first task must now be EXPECTED, and the vendor code that was in scope must not be. That flip is the whole point of the boundary following the conversation.

[`demo/EXPECTED-GRAPH.md`](demo/EXPECTED-GRAPH.md) is the graph hand-derived from the source **before** the analyzer was written, so the analyzer could not be quietly bent to match whatever it happened to output.

## Supported agents

| Agent | Level | How |
|---|---|---|
| **Claude Code** | Full | `PreToolUse` hook — challenges *before* the edit is written |
| **Codex CLI** | Full | `PreToolUse` hook — same mechanism, same decisions ([one caveat](#codex-hooks-need-an-interactive-session)) |
| Cursor · Windsurf · Gemini CLI · Cline | Coming soon | Same adapter interface |

Supporting two agents cost an afternoon rather than a week because they accept an identical decision payload:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "…" } }
```

The config files are now byte-identical; only their paths differ. What differs is the edit payload: Claude Code reports one `tool_input.file_path` per call, while Codex reports an `apply_patch` envelope that can carry **several files in a single hook invocation**. A real Codex run classified four files in one call in 4ms. Both shapes are normalised in [`src/hook/input.ts`](src/hook/input.ts), which is the entire adapter layer.

### Codex hooks need an interactive session

Codex asks you to review and trust a hook file the first time it sees one, and `codex exec` cannot show that prompt — so in non-interactive mode it starts, edits, and **runs no hooks at all**, with nothing printed to say so.

That is Codex's behaviour, not Ichor's, but it is worth knowing before you conclude the integration is broken:

```bash
codex          # hooks run — approve the trust prompt on first use
codex exec …   # hooks are skipped, silently
```

Verified against Codex CLI 0.147.0, from both `<repo>/.codex/hooks.json` and `~/.codex/hooks.json`, with a `.*` matcher, on a trusted project, with `hooks` reported as a stable enabled feature.

Both agents also get an **MCP server**, so the agent can ask why something was flagged and argue its case instead of simply being refused:

| Tool | What it does |
|---|---|
| `ichor_task_status` | is there an active task, and what is in it |
| `ichor_get_scope` | the neighbourhood, with distances |
| `ichor_check_change` | classify a file before writing it |
| `ichor_explain` | why this verdict, with the paths behind it |
| `ichor_request_scope_expansion` | argue for the boundary to grow |
| `ichor_callers` | who reaches this function, and from which endpoints |
| `ichor_paths` | how the app reaches a table, and through what |

The last two are not about policing at all — they exist because the graph is genuinely useful to the agent. In a real Codex run, before writing a single line it searched the repo for five words, got 116 hits, and read six entire files, to work out which code the task lived in. Ichor had already answered that in 14ms and could simply have been asked.

Both report truncation rather than quietly returning the first N (rule 2), and `ichor_paths` says plainly that it returns path summaries — entry point, handler, the function that touches the data — because `algo.SPpaths` is rejected over Bolt on this build.

## The Judge (optional)

Structure is never decided by a model. The compiler and the graph decide what is connected; there is no LLM anywhere near the analysis.

A model is asked exactly one question: when an agent **argues** that an expansion is necessary, is that argument supported by the evidence the graph produced? Set `OPENROUTER_KEY` in `.env` to enable it.

**Ichor is fully functional with no key at all.** No key simply means no expansion is ever granted on an argument alone — everything unverifiable goes to you instead.

`npm run judge:test` measures it on three cases, three runs each. Two are an agent arguing for an endpoint the codebase already makes unnecessary — including an authoritative *"OWASP mandates this"* framing — where the Judge must refuse. The third is a claim about **user behaviour**, which a call graph structurally cannot see, where it must ask the developer rather than assert:

| Model | 3 runs | Price (out) |
|---|---|---|
| `openai/gpt-5-mini` — primary | **8/9** | $2.00/M |
| `deepseek/deepseek-v4-flash` — fallback | **8/9** | $0.13/M |
| `openai/gpt-oss-120b` | 7/9 — one run collapsed to 1/3 | $0.17/M |
| `qwen/qwen3.7-flash` | 6/9 — over-refuses every time | $0.13/M |

Every model resisted the authoritative argument, which is the behaviour that matters most. Nothing beat the fallback on this suite, which is the property you want from one — dropping to it costs nothing measurable.

All the remaining variance is the third case: whether a model **escalates** a claim it cannot check, or refuses it outright. Refusing everything looks careful and is useless, so that case exists to catch it.

> Worth stating plainly: an earlier version of that third case claimed a five-step wizard, and the demo has a single `<form onSubmit>`. The premise was contradicted by the fixture, so refusing it was *correct*, and every model "failed" a case by being right. The published 3/3 vs 2/3 comparison came from that broken case. It is fixed, and the numbers above are the re-measured ones.

The Judge is capped at 25 calls per task and 2 per file, and only runs when an agent actually argues — a whole hackathon costs pennies.

## Your code never leaves your machine

Ichor runs HydraDB and MinIO locally through Docker. The graph of your codebase — every function, route and model name — stays on your disk. Every port binds to `127.0.0.1`. There is no account and no telemetry.

The only outbound request Ichor can ever make is to OpenRouter, only if you set a key, and only carrying the task description, the file path, and the paths the graph already found.

## How it is built

```
src/
  extract/     ts-morph → functions, calls, routes, Prisma models   (no LLM)
  graph/       the only place that talks to HydraDB over Bolt
  scope/       anchors → neighbourhood → the two tests
               taskSwitch.ts — is this prompt still the same job? (pure, no I/O)
  hook/        the three events, and the installer for both agents
  refresh/     the detached rebuild that runs between turns
  mcp/         MCP server over stdio, so the agent can argue and ask
  judge/       OpenRouter, used only to weigh an argument
  stack/       the local HydraDB stack Ichor writes into your repo
  ids.ts       stable node ids — the load-bearing 60 lines
demo/          Next.js + Prisma app with the real bug in it
```

Three decisions carried most of the weight:

**Ids are content-derived, not database-assigned.** FNV-1a folded to 52 bits so a JS number holds it exactly, with paths normalised so Windows and Linux produce the same id for the same file. A collision throws rather than silently merging two functions into one node.

**Precision over recall.** Ichor stays silent when it is unsure. A false challenge costs trust; a missed one costs nothing that a code review would not have cost anyway.

**Two tiers of knowledge, permanently separated.** The compiled graph is the only thing that may be quoted as evidence. While the agent works, code it has just written is tracked as a much weaker, name-based overlay — enough to see that a new file connects to something it made two edits ago, never enough to appear in a challenge. Folding that cheap parse into the graph would mean challenging an agent on relationships the compiler never confirmed, and the whole product rests on not doing that.

## Notes for HydraDB

Things found the hard way while building on it, offered back:

- **`CLOUD_PROVIDER=local` cannot sustain writes** — manifest GC fails permanently. The working configuration is S3-compatible storage, which for a local stack means MinIO.
- **`AWS_ALLOW_HTTP=true` and `AWS_VIRTUAL_HOSTED_STYLE_REQUEST=false` are required for MinIO**, and appear only in the benchmark harness, not the README. Without them the node starts, listens on 7687, and every object-store operation fails — a healthy-looking dead node. This cost a day, and is commented in full in [`docker-compose.yml`](docker-compose.yml).
- **`RETURN 1` is rejected.** Health checks have to match a real label — Ichor uses `MATCH (n:IchorHealthCheck) RETURN count(*)`.
- **Ids must be sent as Bolt integers.** A plain JS number encodes as FLOAT and is rejected with *"field vertex must be a non-negative integer"*; every id goes through a `gInt()` wrapper.
- **Bolt chunk framing occasionally races the JS driver**, surfacing as `RangeError: offset is out of range` thrown from inside `session.run`. It hit roughly 1 in 6 hook invocations before [`src/graph/client.ts`](src/graph/client.ts) grew a 4-attempt reconnect. Worth a look — it is a driver-visible framing issue, not a query problem.
- **`LIMIT` truncates silently**, so any query whose *ranking* matters has to over-fetch and rank client-side.
- **A variable-length segment cannot start from an unbound node** — *"variable-length MATCH requires a fixed source id"*. `MATCH (c:Function)-[:CALLS*1..4]->(t:Function) WHERE t.name = $name` is rejected, because the node being pinned is the target. Anything traversing *backwards* from a known node has to pin an id and widen one hop at a time.
- **`algo.SPpaths` is unavailable over Bolt** on this build — *"query transport cannot authorize an unsupported Cypher clause"* — so whole paths with every intermediate hop cannot be fetched, only summaries assembled from bounded traversal.
- **`DETACH DELETE` is the bottleneck, by a wide margin.** Roughly **96ms per node**, against a 30-second statement ceiling — so a 2,265-function graph cannot be wiped at all, and even 300 nodes takes 28.8s. There is no batched alternative in the subset: `UNWIND … MATCH … DETACH DELETE` is rejected ("UNWIND batch node patterns do not support"), and `MATCH (n) WITH n LIMIT 100 DETACH DELETE n` is rejected as a non-executable write. Writes, by contrast, are quick — 500 nodes in 82ms, 500 edges in 304ms.
- **A batch is capped at 1024 items** — "client_query_batch_items rejected by admission control".
- **`MERGE` on a relationship with an explicit id is idempotent**, and this is what makes rebuilding viable: two identical passes leave 49 edges rather than 98. Ichor therefore never wipes. Nodes and edges both upsert, and only genuinely-deleted code is removed.
- **`MERGE … SET` is rejected on its own** — "MERGE with following clauses is not executable" — but the same pair inside `UNWIND $rows AS row` is fine.
- **Relationship properties need an explicit id.** `CREATE (a)-[:R {x: row.x}]->(b)` is rejected with *"UNWIND relationship CREATE properties require id: row.&lt;field&gt;"*; the edge needs its own id column before it will accept any property.

The Cypher subset was never a problem in practice. Depth is close to free — the neighbourhood walk is the cheapest part of the whole pipeline.

## On a real codebase

The demo proves the idea; it does not prove the engineering. So Ichor was run against [papermark](https://github.com/mfts/papermark) — an open-source document-sharing product, **1,386 TypeScript files**:

| | |
|---|---|
| functions / routes / models / fields | 2,265 · 69 · 78 · 1,213 |
| call sites resolved | **81.8%** (18.2% unresolved — the same rate as the 11-file demo) |
| first build | ~55s, dominated by ts-morph |
| rebuild | ~58s |
| task boundary | 317 functions — 14% of the repo |
| prompt classification | under 2s |

Four real bugs came out of it, none of which the demo could ever have surfaced:

1. **Three of four real repos keep their Prisma schema where we did not look.** The modern multi-file layout (`prisma/schema/*.prisma`) is the default for anything large. Ichor found zero models and silently lost its whole data layer. It now walks for schema files instead of guessing paths.
2. **One unusual file aborted the entire analysis.** A route exported as `export { handler as GET, handler as POST }` produced an edge pointing at a function node that was never created, and HydraDB rejects the whole statement when an endpoint is missing. Export aliases are now followed to the real declaration, and any edge that still cannot be anchored is dropped *and counted*.
3. **The boundary swallowed 56% of the repository.** Walking *inward* — to everything that calls the task's code — is what exploded: 804 of 1,271 members arrived that way, because every shared helper has hundreds of callers. Outward and inward are no longer symmetric, which brought it to 14%.
4. **Rebuilding was impossible.** See the delete numbers above. Switching to idempotent upserts removed the need to delete at all.

**One codebase per database.** Nodes are keyed by repo-relative path, so two repositories with a `src/lib/db.ts` each would collide, and the previous repo's graph is far too large to remove in place. Pointing Ichor at a second repo therefore fails with the fix rather than quietly answering about a mixture of two codebases:

```
This HydraDB already holds the graph for /path/to/first-repo.
For a clean graph:  ichor down --wipe && ichor up
```

## What it cannot do — please read

- **TypeScript and JavaScript only.** Python is next. Nothing else is claimed.
- **Static analysis.** Dynamic dispatch and runtime-constructed calls are invisible, so results are a floor and never a ceiling.
- **Shell writes are unseen.** Ichor hooks the agents' edit tools; a file written by `cat >` or a codegen script bypasses it entirely.
- **The initial boundary is an expectation, not a fact.** It is designed to grow when the work justifies it.
- **The graph is rebuilt between turns, not during them.** While the agent works, new code it writes is tracked as a weaker, name-based hint — good enough to see that a new file connects to something it just created, never good enough to be quoted as evidence. The compiled graph is rebuilt when the agent stops talking. So within a single turn the graph can be a few edits behind.
- **Task detection can be wrong.** It moves the boundary only when a prompt points somewhere the boundary does not cover, and anything ambiguous — "continue", a pasted stack trace, a question — changes nothing. `ichor status` always shows what it decided, and `ichor start` overrides it.
- **One conversation at a time per repo.** Task state is per-repo, so two agent sessions in the same checkout share one boundary; the newer session takes it over. Per-session isolation is not built.
- **One codebase per database.** Pointing Ichor at a second repo fails with instructions rather than mixing two graphs — see [On a real codebase](#on-a-real-codebase).
- **Analysis is the slow part.** ~1.6s on the demo, ~55s on a 1,386-file repo. It runs detached between turns, so it never blocks you, but on a large codebase the graph trails the code by about a minute.
- **Ichor can be wrong.** When it cannot validate a justification it asks you, rather than deciding for you.

## Roadmap

Python analyser · cross-language repositories · Cursor / Windsurf / Gemini / Cline adapters · per-session boundaries so two agents can share a repo · team history (*"what does a task like this normally touch in this codebase?"*).

## Credits

- [HydraDB](https://github.com/hydra-db/hydradb) — object-store-native graph database (AGPL-3.0)
- [ts-morph](https://ts-morph.com/) — TypeScript compiler API wrapper
- [neo4j-driver](https://github.com/neo4j/neo4j-javascript-driver) — Bolt client
- [MinIO](https://min.io/) — S3-compatible object storage
- [OpenRouter](https://openrouter.ai/) — model routing for the Judge

## Licence

MIT — see [LICENSE](LICENSE).
