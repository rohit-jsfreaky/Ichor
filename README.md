# Ichor

**You asked for three files. It changed twenty.**

Ichor watches your AI coding agent while it works, and challenges it the moment it goes past the job you actually gave it — not at review time, when the twenty files are already written.

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

That is not a mock-up. It is the literal output of `ichor hook` against the demo app in this repository, and you can reproduce it in about five minutes.

There is no task to type. Ichor takes the job from what you already said to your agent.

> Built for [Hack Hydra](https://hackhydra.hydradb.com/) 2026 · Track 02 · solo.

---

## How it decides

A task is almost never one folder. *"Change invite expiry from 24 to 48 hours"* can live across a page, an action, a service, a token helper, a config constant, a database model and a test — files sharing no vocabulary and no directory. So the boundary cannot be `src/vendors/**`, and it cannot be "files that read like the task description" either.

The only thing that actually connects those files is the structure of the program: which function calls which, which route is handled by what, which function touches which table. Ichor keeps that structure in [HydraDB](https://github.com/hydra-db/hydradb) and reasons over the task's connected neighbourhood.

**The graph is not the product. It is the evidence.** Every sentence Ichor shows an agent is a path it can point at.

Two tests, in order:

**Is this edit connected to the task?** Ichor anchors your words to real routes, functions and model fields, then follows actual call structure outward. A new file is judged by what it *reaches*, never by being new — real work creates files constantly.

**Does an existing path already do this?** The harder one. A new `/api/vendors/check-email` endpoint passes the first test easily: it queries `Vendor` by email and sits beside the other vendor routes. It is still wrong, because the submit path already reaches the `email @unique` constraint. That is a second flow for a rule the codebase already enforces, and only a graph can say so.

When an agent *argues* that an expansion is necessary, one model is asked one question: is that argument supported by the evidence the graph produced? Structure is never decided by a model. **Ichor works fully without an API key** — no key simply means no expansion is granted on an argument alone, and anything unverifiable comes to you instead.

## Does it actually work?

A tool that questions correct work gets uninstalled the same afternoon, so that is the thing worth measuring — and passing tests on a toy demo says nothing about it.

So Ichor was measured against **30 real commits** from [papermark](https://github.com/mfts/papermark), a real document-sharing product. Every commit is a labelled example: its message is the task, and the files it changed are what a developer genuinely had to touch. Each one was replayed through the real classifier.

| | at the start | now |
|---|---|---|
| **real edits wrongly challenged** | **62.7%** | **19.3%** |
| real changed code inside the boundary | 52.5% | 69.7% |
| median task area | 8.0% of the repo | 8.9% |
| worst-case task area | 23.3% | 12.1% |

That first measurement is why this section exists. Ten-out-of-ten on an eleven-file demo was hiding a tool that interrupted **nearly two thirds** of genuine work on a real codebase. Four defects came out of it — an anchor cap that bound on every single task, damping that suppressed the very words identifying a domain's subject, existing files judged more harshly than new ones, and a rule excluding shared code that tasks are often *about*.

**Being honest about it:** a real commit is not always one clean task — developers bundle incidental changes — so some of that 19.3% may be Ichor correctly questioning a tangential edit. Nothing separates those, and no credit is claimed for it. One repository, 30 commits, TypeScript.

Reproduce it with `npx tsx scripts/ground-truth.ts collect <repo>` then `alarms <repo>`.

### Speed

| | papermark (1,362 files) | cal.com (4,975 files) |
|---|---|---|
| first index | 26s | **35s** |
| refresh after editing one file | **7s** | **5s** |
| refresh with nothing changed | **6s** | — |

Refreshes re-read only what changed, and `npm run incremental:test` asserts that an incremental read is **identical** to a full one — every function, call, reference and table touch — because a stale graph never announces itself.

Papermark yields 3,471 functions and 18,983 connections between them.

## Quick start

```bash
npm i -g ichor-cli

cd your-repo
ichor init     # installs hooks + MCP, writes the HydraDB stack
ichor up       # starts HydraDB and MinIO locally
ichor watch    # reads the codebase and follows the conversation
```

Then use Claude Code or Codex exactly as you normally would.

```
> fix the duplicate email crash in vendor onboarding
  [ichor] task set — 14 functions, data: Vendor

  …hours later, same conversation…

> now fix the rounding on billing invoices
  [ichor] new task — 3 functions, data: Invoice
```

That matters more than it looks. Nobody runs a CLI command between tasks, so a boundary set at 9am would still be policing vendor code at 2pm while you are deep in billing — challenging every edit until you turn the thing off.

```bash
ichor status      # what is in scope, what was challenged, what was forced through
ichor start "…"   # name the task by hand; detection then reports but never redraws
ichor stop        # stop watching
ichor down        # stop the database   (--wipe also deletes the graph)
```

**Requirements:** Node 20+, Docker, and a TypeScript repo — ideally Next.js with Prisma.

Several projects can share one database, so you can watch as many repos as you like at once. `ichor init` writes `docker-compose.ichor.yml` into your repo and adds `.ichor/` to `.gitignore`. It *merges* into an existing `.claude/settings.json`, `.codex/hooks.json` and `.mcp.json` rather than overwriting them.

## Verify it yourself

This repository contains a small Next.js + Prisma vendor app with the duplicate-email bug already in it.

```bash
git clone https://github.com/rohit-jsfreaky/ichor && cd ichor
npm install
npm run up                  # HydraDB + MinIO via Docker
npm run smoke               # round-trips a real write; a listening port is not proof
npm run build

npm test                    # 109 unit tests
npm run check               # 10 classification scenarios, incl. a mid-session job switch
npm run hook:test           # 6 hook cases, spawning the real CLI as an agent would
npm run mcp:test            # 13 MCP protocol checks
npm run multi:test          # 10 checks that two projects never bleed into each other
npm run incremental:test    # 5 checks that a partial re-read equals a full one
```

`npm run check` is the one to read. It runs the vendor task, then **switches job mid-session** to billing: the billing file that was SUSPICIOUS under the first task must now be EXPECTED, and the vendor code that was in scope must not be. That flip is the whole point of a boundary that follows the conversation.

[`demo/EXPECTED-GRAPH.md`](demo/EXPECTED-GRAPH.md) is the graph hand-derived from the source **before** the analyzer was written, so the analyzer could not be quietly bent to match its own output.

## Supported agents

| Agent | Level | How |
|---|---|---|
| **Claude Code** | Full | `PreToolUse` hook — challenges *before* the edit is written |
| **Codex CLI** | Full | `PreToolUse` hook — same mechanism, same decisions |
| Cursor · Windsurf · Gemini CLI · Cline | Coming soon | Same adapter interface |

> **Codex caveat:** Codex asks you to trust a hook file the first time it sees one, and `codex exec` cannot show that prompt — so in non-interactive mode it runs **no hooks at all**, silently. Use interactive `codex` and approve the prompt once. That is Codex's behaviour, not Ichor's, but it is worth knowing before concluding the integration is broken.

Both agents also get an MCP server, so an agent can ask why something was flagged and argue its case rather than simply being refused:

| Tool | What it does |
|---|---|
| `ichor_task_status` | is there an active task, and what is in it |
| `ichor_get_scope` | the neighbourhood, with distances |
| `ichor_check_change` | classify a file before writing it |
| `ichor_explain` | why this verdict, with the paths behind it |
| `ichor_request_scope_expansion` | argue for the boundary to grow |
| `ichor_callers` | who reaches this function, and from which endpoints |
| `ichor_paths` | how the app reaches a table, and through what |

The last two are not about policing. In a real Codex run, before writing a line it searched the repo for five words, got 116 hits, and read six whole files to work out where the task lived. Ichor had already answered that in 14ms and could simply have been asked.

## What it cannot do

- **TypeScript and JavaScript only.** Python is next. Nothing else is claimed.
- **It still challenges about one edit in five** that a developer would have made anyway. Measured, not estimated — see above.
- **Static analysis.** Dynamic dispatch and runtime-constructed calls are invisible, so results are a floor, never a ceiling. `obj.method()` on a value whose type only the compiler knows is counted, not guessed.
- **Shell writes are unseen.** Ichor hooks the agent's edit tools; a file written by `cat >` or a codegen script bypasses it entirely.
- **The boundary is an expectation, not a fact.** It is designed to grow when the work justifies it.
- **The graph is rebuilt between turns, not during them.** Code the agent writes mid-turn is tracked as a weaker, name-based hint — enough to see that a new file connects to something it just created, never enough to be quoted as evidence.
- **Task detection can be wrong.** It moves the boundary only when a prompt points somewhere the boundary does not cover; anything ambiguous changes nothing. `ichor status` shows what it decided and `ichor start` overrides it.
- **One conversation at a time per repo.** Two agent sessions in one checkout share a boundary; the newer takes it over.
- **Ichor can be wrong.** When it cannot validate a justification it asks you, rather than deciding for you.

## Your code never leaves your machine

HydraDB and MinIO run locally through Docker. The graph of your codebase stays on your disk, every port binds to `127.0.0.1`, and there is no account and no telemetry.

The only outbound request Ichor can make is to OpenRouter, only if you set a key, and only carrying the task description, the file path, and paths the graph already found.

## Credits

[HydraDB](https://github.com/hydra-db/hydradb) · [ts-morph](https://ts-morph.com/) · [neo4j-driver](https://github.com/neo4j/neo4j-javascript-driver) · [MinIO](https://min.io/) · [OpenRouter](https://openrouter.ai/)

Engineering notes, the HydraDB workarounds behind these decisions, and the bugs found on real codebases live in [`docs/`](docs/).

## Licence

MIT — see [LICENSE](LICENSE).
