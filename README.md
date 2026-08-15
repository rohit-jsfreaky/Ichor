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

## Quick start

```bash
npm i -g ichor-cli

cd your-repo
ichor init                                   # installs hooks + MCP, writes the HydraDB stack
ichor up                                     # starts HydraDB and MinIO locally
ichor start "fix duplicate email handling"   # works out the task neighbourhood
```

Then run Claude Code or Codex exactly as you normally would.

```bash
ichor status      # what is currently in scope, what was challenged, what grew
ichor stop        # end the task
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

npm test            # 44 unit tests
npm run check       # 7 classification scenarios end to end
npm run hook:test   # 6 hook cases, spawning the real CLI as an agent would
npm run mcp:test    # 9 MCP protocol checks
```

To watch it work on the demo app:

```bash
node dist/src/cli.js start "fix duplicate email handling in vendor onboarding" --repo ./demo
```

```
  reading the codebase…  17 functions, 10 calls, 2 routes
  building the graph…    57 nodes, 71 edges
  finding the task area… 13 functions

Data this task is about: Vendor

Watching. Run your agent as usual.
```

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

## The Judge (optional)

Structure is never decided by a model. The compiler and the graph decide what is connected; there is no LLM anywhere near the analysis.

A model is asked exactly one question: when an agent **argues** that an expansion is necessary, is that argument supported by the evidence the graph produced? Set `OPENROUTER_KEY` in `.env` to enable it.

**Ichor is fully functional with no key at all.** No key simply means no expansion is ever granted on an argument alone — everything unverifiable goes to you instead.

The recommended model is `openai/gpt-5-mini`, chosen by measurement rather than reputation. `npm run judge:test` pressure-tests the Judge with an agent arguing for an endpoint the codebase already makes unnecessary, including an authoritative *"OWASP mandates this"* framing:

| Model | Result |
|---|---|
| `openai/gpt-5-mini` | **3/3** — refuses the pressure, escalates what it cannot verify |
| `deepseek/deepseek-v4-flash` | 2/3 — refuses everything, including a claim it merely lacks evidence for |

Both resisted the authoritative argument, which is the behaviour that matters most. The Judge is also capped at 25 calls per task and 2 per file, and only runs when an agent actually argues — a whole hackathon costs pennies.

## Your code never leaves your machine

Ichor runs HydraDB and MinIO locally through Docker. The graph of your codebase — every function, route and model name — stays on your disk. Every port binds to `127.0.0.1`. There is no account and no telemetry.

The only outbound request Ichor can ever make is to OpenRouter, only if you set a key, and only carrying the task description, the file path, and the paths the graph already found.

## How it is built

```
src/
  extract/     ts-morph → functions, calls, routes, Prisma models   (no LLM)
  graph/       the only place that talks to HydraDB over Bolt
  scope/       anchors → neighbourhood → the two tests
  hook/        PreToolUse handler + installer for both agents
  mcp/         MCP server over stdio, so the agent can argue
  judge/       OpenRouter, used only to weigh an argument
  stack/       the local HydraDB stack Ichor writes into your repo
  ids.ts       stable node ids — the load-bearing 60 lines
demo/          Next.js + Prisma app with the real bug in it
```

Two decisions carried most of the weight:

**Ids are content-derived, not database-assigned.** FNV-1a folded to 52 bits so a JS number holds it exactly, with paths normalised so Windows and Linux produce the same id for the same file. A collision throws rather than silently merging two functions into one node.

**Precision over recall.** Ichor stays silent when it is unsure. A false challenge costs trust; a missed one costs nothing that a code review would not have cost anyway.

## Notes for HydraDB

Things found the hard way while building on it, offered back:

- **`CLOUD_PROVIDER=local` cannot sustain writes** — manifest GC fails permanently. The working configuration is S3-compatible storage, which for a local stack means MinIO.
- **`AWS_ALLOW_HTTP=true` and `AWS_VIRTUAL_HOSTED_STYLE_REQUEST=false` are required for MinIO**, and appear only in the benchmark harness, not the README. Without them the node starts, listens on 7687, and every object-store operation fails — a healthy-looking dead node. This cost a day, and is commented in full in [`docker-compose.yml`](docker-compose.yml).
- **`RETURN 1` is rejected.** Health checks have to match a real label — Ichor uses `MATCH (n:IchorHealthCheck) RETURN count(*)`.
- **Ids must be sent as Bolt integers.** A plain JS number encodes as FLOAT and is rejected with *"field vertex must be a non-negative integer"*; every id goes through a `gInt()` wrapper.
- **Bolt chunk framing occasionally races the JS driver**, surfacing as `RangeError: offset is out of range` thrown from inside `session.run`. It hit roughly 1 in 6 hook invocations before [`src/graph/client.ts`](src/graph/client.ts) grew a 4-attempt reconnect. Worth a look — it is a driver-visible framing issue, not a query problem.
- **`LIMIT` truncates silently**, so any query whose *ranking* matters has to over-fetch and rank client-side.

The Cypher subset was never a problem in practice. Depth is close to free — the neighbourhood walk is the cheapest part of the whole pipeline.

## What it cannot do — please read

- **TypeScript and JavaScript only.** Python is next. Nothing else is claimed.
- **Static analysis.** Dynamic dispatch and runtime-constructed calls are invisible, so results are a floor and never a ceiling.
- **Shell writes are unseen.** Ichor hooks the agents' edit tools; a file written by `cat >` or a codegen script bypasses it entirely.
- **The initial boundary is an expectation, not a fact.** It is designed to grow when the work justifies it.
- **The graph is a snapshot.** It is built at `ichor start` and not updated as the agent edits, so a function created during the task is judged by what it reaches, not by what later calls it.
- **One repo at a time.** `ichor start` wipes the graph and rebuilds it, so a single local HydraDB holds one codebase at a time. Starting a task in a second repo replaces the first — go back and you simply run `ichor start` again.
- **Ichor can be wrong.** When it cannot validate a justification it asks you, rather than deciding for you.

## Roadmap

Python analyser · cross-language repositories · Cursor / Windsurf / Gemini / Cline adapters · incremental graph updates during a task · team history (*"what does a task like this normally touch in this codebase?"*).

## Credits

- [HydraDB](https://github.com/hydra-db/hydradb) — object-store-native graph database (AGPL-3.0)
- [ts-morph](https://ts-morph.com/) — TypeScript compiler API wrapper
- [neo4j-driver](https://github.com/neo4j/neo4j-javascript-driver) — Bolt client
- [MinIO](https://min.io/) — S3-compatible object storage
- [OpenRouter](https://openrouter.ai/) — model routing for the Judge

## Licence

MIT — see [LICENSE](LICENSE).
