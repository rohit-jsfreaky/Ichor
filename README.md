<img src="web/icon.svg" width="48" height="48" alt="" />

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

## "Isn't this just a code graph?"

No. Ichor keeps one, but the graph is not the product — it is the evidence.

Code-graph tools like [Graphify](https://github.com/Graphify-Labs/graphify) map a codebase so you can **query it instead of grepping**. You ask, it answers, and you decide what to do. They are good at that, they cover ~40 languages and your docs and PDFs too, and Ichor is not trying to be one.

Ichor answers a different question, and only one:

> **Should this specific edit, that your agent is about to write, be part of the job you asked for?**

That is not a retrieval question, and three things follow from it.

**It runs whether you ask or not.** A graph tool is a library the agent consults when it chooses to. Ichor sits in the write path — every edit goes through it, before the file exists.

**It knows what you are working on.** No code graph has a notion of today's task. Ichor reads it from your prompt, keeps it across the conversation, and moves it when you switch jobs. That boundary is the thing that does not exist elsewhere.

**Connected is not the same as necessary.** This is the real difference, and it is easiest to see in an example.

Your agent adds `/api/vendors/check-email` during a duplicate-email fix. Ask *any* graph whether it relates to the task:

```
check-email/route.ts
  ├── queries Vendor            ✓ same table as the task
  ├── sits in api/vendors/      ✓ same folder
  └── imports the vendor service ✓ same code
```

Everything says **yes, related** — and it is. So relatedness gives you no reason to object. Ichor asks the next question instead:

```
the task's existing path:
   POST /api/vendors ────► createVendor ────► Vendor.email  (unique)
                                                   ▲
   the new endpoint:                               │
   POST /api/vendors/check-email ──────────────────┘
        reaches the SAME rule by a SECOND road
```

The database already refuses duplicate emails, and the submit path already reaches that rule. So the endpoint is connected, relevant, and **unnecessary** — a second enforcement of something already enforced.

They solve different problems. You could reasonably run both.

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

| | |
|---|---|
| **real edits wrongly challenged** | **12.8%** |
| real changed code inside the boundary | 68.4% |
| median task area | 8.9% of the repo |
| worst-case task area | 12.1% |

By file type, at 12.8%: `.ts` 10 of 45 · `.tsx` **1 of 26** · `.prisma` **0 of 2** · everything else **0**.

Scope of the measurement: one repository, 30 commits, 86 changed files of every type, TypeScript.

Reproduce it with `npx tsx scripts/ground-truth.ts collect <repo>` then `alarms <repo>`.

### Speed

| | papermark (1,362 files) | Infisical (7,735 files) |
|---|---|---|
| first index, empty database | 25s | 2m 21s |
| second index, nothing changed | **6s** | **16s** |
| reading the code alone | 15s | 82s |
| peak memory | 346 MB | 788 MB |

Both at Node's default heap — there is no `--max-old-space-size` anywhere in the code, the docs or the scripts. `npm run read:test -- <repo>` runs one process per repository and reports peak memory, so "can Ichor read this codebase" is a question you can answer about your own before installing anything.

Refreshes re-read only what changed, and `npm run incremental:test` asserts that an incremental read is **identical** to a full one — every function, call, reference and table touch — because a stale graph never announces itself.

Papermark yields 3,471 functions and **21,384** connections between them. `npm run delta:test -- <repo>` checks the graph against the code after a write, per relationship type, and checks the local record of what was written against both — because a fast write and a correct one are different things, and a graph that is subtly wrong still answers confidently.

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
ichor key         # store your own OpenRouter key — optional, see below
ichor stop        # stop watching
ichor down        # stop the database, from any directory
                  # --wipe also deletes the graph — every project in it, not just this one
```

### Verdicts you will see

`ichor status` and `.ichor/hook.log` use five words, and only two of them interrupt you.

| Verdict | Meaning |
|---|---|
| `EXPECTED` | This is the job. Silent. |
| `CONNECTED` | Not the job, but genuinely joined to it — one call away, or working on the same table. Silent. |
| `NOT_JUDGED` | Not a file Ichor reads, so it has no opinion. Silent, and honest about why. |
| `SUSPICIOUS` | Outside the job, with evidence. You get asked. |
| `HUMAN_REVIEW` | Ichor cannot tell. It asks you rather than deciding. |

A challenge is not a block. Explain why the change is needed and carry on — Ichor asks **once per file**. A file that was questioned and written anyway is remembered as exactly that, and is never later quoted back as proof that something else belongs.

### The optional API key

**Ichor works fully without one.** Every boundary, every challenge, every piece of evidence and all nine tools your agent can call need no key and make no outbound request.

A key adds exactly one thing: when your agent *argues* that an expansion is genuinely necessary, that argument can be weighed against the evidence the graph produced. Without a key, an argument Ichor cannot verify comes to **you** instead of being granted.

```bash
ichor key sk-or-…        # get one at https://openrouter.ai/keys
ichor key                # is one set, and where did it come from?
ichor key --remove       # delete it
```

The key is checked with OpenRouter before it is stored, so a truncated paste is caught immediately rather than becoming a feature that quietly does nothing. It is written to **`~/.ichor/credentials.json`** in your home directory, readable only by you and deliberately *outside* every repository so it cannot be committed by accident. An exported `ICHOR_OPENROUTER_KEY` always wins over the stored one, which is what you want in CI.

Cost is bounded by design: the Judge is never consulted on an ordinary edit, only when an argument has actually been made, and it is capped per task **and** per file.

### Environment

**Requirements:** Node 20+, Docker, and a TypeScript repo — ideally Next.js with Prisma.

**One database per repository.** Projects never bleed into each other — that is tested with four loaded at once — but HydraDB has no property indexes, so scoping a query to one repo is a scan that grows with the whole database. Three share one comfortably; more will not, which is why `ichor init` writes `docker-compose.ichor.yml` into each repo.

`ichor init` also adds `.ichor/` to your `.gitignore`, *merges* into an existing `.claude/settings.json`, `.codex/hooks.json` and `.mcp.json` rather than overwriting them, and allows its own MCP tools so the first session is not a queue of permission prompts.

None of these variables are required. Ichor picks sensible values and `ichor init` writes the rest.

| Variable | Default | Purpose |
|---|---|---|
| `ICHOR_OPENROUTER_KEY` | — | Your OpenRouter key. `OPENROUTER_API_KEY` and `OPENROUTER_KEY` are also read. Beats the stored key. |
| `ICHOR_JUDGE_MODEL` | `openai/gpt-5-mini` | Which model weighs an argument. A cheap fallback is always tried second. |
| `ICHOR_JUDGE_MAX_PER_TASK` | bounded | How many times one task may consult the Judge. |
| `ICHOR_JUDGE_MAX_PER_FILE` | bounded | How many times one file may. |
| `ICHOR_JUDGE_TIMEOUT_MS` | `20000` | Give up on the model and fall back to the graph-only verdict. |
| `ICHOR_HYDRA_URL` | `bolt://127.0.0.1:7687` | Where HydraDB is listening. |
| `ICHOR_HYDRA_TOKEN` | generated | Auth token for the local database. Written by `ichor up`. |
| `ICHOR_HYDRA_NAMESPACE` | default | Namespace inside HydraDB. |
| `ICHOR_DEBUG` | — | `1` mirrors the hook log to stderr while you work. |

### When something is wrong

**Ichor said nothing at all.** It fails open on purpose — no task, no database, a parse error, a timeout: every one of those allows the edit, because a tool that blocks work when it breaks gets uninstalled within the hour. So it always writes down why. `.ichor/hook.log` has one line per decision, and it distinguishes "decided to stay quiet" from "never ran".

**"HydraDB is not answering on the Bolt port."** Run `ichor up` and give Docker a moment.

**Codex runs no hooks.** See the caveat under [Supported agents](#supported-agents).

**It questioned something it should not have.** About one edit in eight, measured. Tell your agent why and carry on. If a boundary is plainly wrong, `ichor start "…"` names the task yourself and detection stops redrawing it.

Full documentation, laid out as a page: [`web/docs.html`](web/docs.html).

## Verify it yourself

This repository contains a small Next.js + Prisma vendor app with the duplicate-email bug already in it.

```bash
git clone https://github.com/rohit-jsfreaky/ichor && cd ichor
npm install
npm run up                  # HydraDB + MinIO via Docker
npm run smoke               # round-trips a real write; a listening port is not proof
npm run build

npm test                    # 176 unit tests
npm run check               # 10 classification scenarios, incl. a mid-session job switch
npm run hook:test           # 6 hook cases, spawning the real CLI as an agent would
npm run mcp:test            # 18 MCP protocol checks
npm run multi:test          # 10 checks that two projects never bleed into each other
npm run incremental:test    # 5 checks that a partial re-read equals a full one
npm run session:test        # 12 cases a real session hits and nothing else tested
npm run read:test -- <repo>   # can it read a real codebase at the default heap?
npm run delta:test -- <repo>  # does the graph match the code after a write?
npm run named:gate -- <repo>   # does naming a file narrow scope, and nothing else?
npm run judge:test            # a live Judge, three cases, a few cents
```

`npm run session:test` is the one that matters most, and it exists because the six suites above it **all passed while eleven real bugs were live**. Every one of them ran against an eleven-file demo. This one drives the real compiled hook over real payloads — a file type Ichor cannot read, a path in no repository, a question instead of an instruction, a rebuild holding the database — and it runs against any repo you point it at, not just the demo.

`npm run named:gate` is the one that shows what a gate is FOR. It asserts two things at once: that naming a file in a prompt narrows the boundary, and that a prompt naming nothing produces a byte-identical answer — including for all 30 commits the published false-alarm rate is measured on. The first half is the feature. The second half is the proof that shipping the feature did not silently invalidate the number.

`npm run check` is the one to read. It runs the vendor task, then **switches job mid-session** to billing: the billing file that was SUSPICIOUS under the first task must now be EXPECTED, and the vendor code that was in scope must not be. That flip is the whole point of a boundary that follows the conversation.

[`demo/EXPECTED-GRAPH.md`](demo/EXPECTED-GRAPH.md) is the graph hand-derived from the source **before** the analyzer was written, so the analyzer could not be quietly bent to match its own output.

## Supported agents

| Agent | Level | How |
|---|---|---|
| **Claude Code** | Full | `PreToolUse` hook — challenges *before* the edit is written |
| **Codex CLI** | Full | `PreToolUse` hook — same mechanism, same decisions |
| Cursor · Windsurf · Gemini CLI · Cline | Coming soon | Same adapter interface |

> **Codex caveat:** Codex asks you to trust a hook file the first time it sees one, and `codex exec` cannot show that prompt — so in non-interactive mode it runs **no hooks at all**, silently. Use interactive `codex` and approve the prompt once. That is Codex's behaviour, not Ichor's, but it is worth knowing before concluding the integration is broken.

> **Claude Code caveat:** `ichor init` adds `mcp__ichor` to `permissions.allow` so the first session is not a queue of prompts, but Claude Code ignores that entry until the workspace is trusted — and untrusted is the default for a fresh clone. Open `claude` interactively in the repo once and accept the trust dialog. The hooks and every verdict work either way; only the pre-approval waits on trust.

### The agent can use the graph, not just be judged by it

Half of Ichor's tools are not about policing at all. They exist because your agent is about to go and grep for something the graph already knows.

In a real Codex run, before writing a line, it searched the repo for five words, got **116 hits**, and read **six entire files** to work out where the task lived. Ichor had that answer in **14ms**.

| Tool | What it answers |
|---|---|
| **`ichor_find`** | **where does X live? Describe it in plain words — no need to guess a name** |
| **`ichor_impact`** | **what breaks if I change this? Callers, endpoints, tables at stake** |
| `ichor_callers` | who reaches this function, and from which endpoints |
| `ichor_paths` | how the app reaches a table, and through what |
| `ichor_task_status` | is there an active task, and what is in it |
| `ichor_get_scope` | the neighbourhood, with distances |
| `ichor_check_change` | classify a file before writing it |
| `ichor_explain` | why this verdict, with the paths behind it |
| `ichor_request_scope_expansion` | argue for the boundary to grow |

These search *structure*, not text — so they find code whose name you could not have guessed, and skip matches in comments and strings.

The scope briefing names these on every prompt, because a tool description alone does not reach an agent — Claude Code defers MCP schemas when several servers are connected, so an unnamed tool is one the agent never sees. With the reminder in place, *"what breaks if I delete the useAuth hook?"* on a real project was answered by **one `ichor_impact` call and nothing else** — no grep, no file reads. *"Where is X?"* still goes to grep, which is fine: grep answers that well. Relationships are what it cannot answer at all.

A live Claude Code session, told to use only these tools, answered *"where is duplicate email handling, and what breaks if I change `createVendor`?"* in nine calls — and found that this repo's own `DuplicateVendorEmailError` and `isDuplicateEmailError` are **never called by anything**. A grep for "duplicate" would have found those files and told you nothing about whether they were wired in.

## What it cannot do

- **TypeScript and JavaScript only.** Python is next. Nothing else is claimed.
- **It still challenges about one edit in eight** that a developer would have made anyway. Measured, not estimated — see above. Every remaining case is a file the boundary did not reach, rather than a file type it refuses to read.
- **A first index of a large repository takes tens of seconds** — 25s for 1,362 files. Once; refreshes are seconds.
- **A retrieval call gives up after 1.5 seconds.** Normal cost is under 200ms, but it has been measured at 40 seconds after heavy churn — a cause I tested three ways and could not isolate, so it is bounded rather than explained. Past the budget Ichor says it has nothing and tells the agent to use Grep instead. `ichor down --wipe && ichor up` restores full speed if you ever see it slow down.
- **One database per repository.** Isolation is correct and tested with four projects loaded at once, but HydraDB cannot index the property that separates them, so each extra project makes every query slower. Three share one comfortably.
- **Static analysis.** Dynamic dispatch and runtime-constructed calls are invisible, so results are a floor, never a ceiling. `obj.method()` on a value whose type only the compiler knows is counted, not guessed.
- **Shell writes cannot be challenged, only accounted for.** Ichor hooks the agent's edit tools, so a file written by `cat >`, a codegen script, a formatter or your own editor is invisible at the moment it happens. It is not invisible afterwards: at the end of the turn Ichor names anything that changed without ever reaching a verdict, so "Ichor said nothing" means *nothing was out of scope* rather than *Ichor was never asked*.
- **The boundary is an expectation, not a fact.** It is designed to grow when the work justifies it.
- **Describe a task in words and the boundary is a superset.** A prompt that names no path is matched on its words, and on a large repo that reaches wider than the job does — asked to change one line, it may claim a hundred files. That means fewer challenges, not more, and the one-in-eight figure above is the measurement of what it costs. Naming the file fixes it outright: see the next point.
- **The graph is rebuilt between turns, not during them.** Code the agent writes mid-turn is tracked as a weaker, name-based hint — enough to see that a new file connects to something it just created, never enough to be quoted as evidence.
- **Task detection can be wrong.** It moves the boundary only when a prompt points somewhere the boundary does not cover; anything ambiguous changes nothing. `ichor status` shows what it decided and `ichor start` overrides it.
- **Name the file you mean, and it does two things.** A prompt that *names* a path moves the boundary however incidental the rest of the sentence, and it also **scopes the boundary to that file** and its graph neighbours instead of searching on words — measured on a 1,378-file repo, 18 files of guesswork down to the 1 you pointed at. So "fix the retry in `backend/src/services/x/y.ts`" is both noticed and precise, where "fix the retry" is neither. A bare filename has to be unique in the repo to count; `index.ts` tells Ichor nothing.
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
