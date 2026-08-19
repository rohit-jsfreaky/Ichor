# Measurements

Every number Ichor publishes, the command that produces it, and what it measured to.

**This file is the source of truth.** If a number appears in `README.md`, `web/index.html`,
`web/docs.html` or a source comment, it must appear here first. If they disagree, this file is
right and the other one is a bug.

Last full re-measure: **2026-08-18**
Partial re-measure after the 19 Aug regression fixes: **2026-08-19** (see the section at the end).
Targets: `papermark` (a real document-sharing product) and `Infisical` (the largest repo tested),
plus `better-auth` and `truffle-ai/dexto` — both pnpm monorepos — added 19 Aug because they
exposed failures the other two could not.

---

## Why this file exists

Four numbers had drifted by the time the project was ready to publish, and one was simply wrong:

- `33,000 call sites` was neither the total (35,264) nor the number actually resolved (16,328).
  The "forty seconds" built on it was correct; the count was not.
- Peak memory had moved on both repos, because both repos get commits.
- `web/docs.html` said "a minute and a half" where the README said `2m 21s`, and "1,400 files"
  where everything else said 1,362.
- `web/docs.html` also described the same two repos as "1,378-file" and "7,741-file" while the
  rest of the site called them 1,362 and 7,735 — a counting-convention difference that looked
  like carelessness. See the note under **The graph**.

None of that was detectable by reading the code. It was only detectable by re-running the
measurements and diffing the output against the prose — so that is now a documented step, and
this table is what makes it cheap.

## The rule that prevents the drift

**Exact figures only for things pinned to a fixed input. Ceilings for anything that varies.**

Counts derived from a repository at a given commit are exact and reproducible. Wall-clock timings
and peak memory depend on the machine, the disk and whatever else is running, and the repo grows
underneath them. Publishing `788 MB` invites a reader to find 757 and conclude the number is
made up; publishing `under 800 MB` is true, survives a year of commits, and makes the same point.

---

## Structural — exact, verified 2026-08-18

| Number | Where it appears | Command | Verified |
|---|---|---|---|
| 11,638 lines of TypeScript | README | `find src -name "*.ts" \| xargs cat \| wc -l` | ✅ exact |
| 31 files | README | `find src -name "*.ts" \| wc -l` | ✅ exact |
| `src/extract/` 2,589 | README table | per-directory `wc -l` | ✅ exact |
| `src/scope/` 2,997 | README table | ″ | ✅ exact |
| `src/hook/` 1,578 | README table | ″ | ✅ exact |
| `src/graph/` 1,421 | README table | ″ | ✅ exact |
| `src/mcp/` 758 | README table | ″ | ✅ exact |
| `src/judge/` 605 | README table | ″ | ✅ exact |
| `src/refresh/` 350 | README table | ″ | ✅ exact |
| `src/stack/` 401 | README table | ″ | ✅ exact |

The eight directories plus 939 lines of top-level `src/*.ts` sum to 11,638. If that stops being
true, one of the numbers is stale.

## Test suites — exact, all green 2026-08-18

| Suite | Count | Command | Verified |
|---|---|---|---|
| unit | 244 | `npm test` | ✅ 244 passed (19 Aug — 212, +18 for the 0.1.5 fixes, +9 for N1–N3, +5 for P2) |
| classification scenarios | 10 | `npm run check` | ✅ 10/10 |
| session harness | 12 | `npm run session:test` | ✅ 12 passed, 0 failed |
| MCP protocol | 20 | `npm run mcp:test` | ⚠️ 20/20 in isolation — see below |
| hook cases | 6 | `npm run hook:test` | ✅ 6/6 |
| multi-project | 10 | `npm run multi:test` | ✅ 10/10 |
| incremental | 5 | `npm run incremental:test` | ✅ 5/5 |
| Judge cases | 3 | `npm run judge:test` | 3 declared (needs a key + a few cents) |

> **`mcp:test` is intermittently flaky under load.** It passed 4 of 5 runs. The failure was
> `RangeError: The value of "offset" is out of range. It must be >= 0 and <= 3. Received 4`, and
> it only appeared when the suite ran immediately after three other suites. That signature is a
> partial-chunk read in the stdio framing — the code assumes a length header arrives whole, and
> under load the chunk boundary lands mid-header. **Open bug.** It does not reproduce in
> isolation, which is exactly why it is written down here.
>
> **19 Aug — that attribution is wrong.** The same `RangeError` appeared in a live session inside a
> BOUNDARY DRAW, nowhere near the MCP server: `prompt: could not reach the graph (The value of
> "offset" is out of range … Received 4)`. The classification succeeded and the graph query failed,
> which puts the fault in the Bolt chunk handling both paths share, not in MCP stdio framing. It is
> therefore not only a flaky test: it silently costs a boundary redraw in ordinary use, leaving the
> boundary stale so the next edit is challenged for it. Recorded as N4 in `BUGS.md`.
>
> Fresh data from the same session, with TWO projects in the database: **16/20 when run immediately
> after five other suites, then 20/20 on three consecutive runs in isolation.** So load, not the
> number of projects, is the trigger — 16/20 is the worst observed so far, against the earlier
> 18/20 at three projects.
>
> **19 Aug, papermark — the cost is now measured, and it is not a test problem.** The same error hit
> the FIRST prompt of a live session, so no boundary was ever drawn and none existed to fall back
> on. Ichor then allowed **30 edits and 22 shell commands without judging one of them**; the agent
> changed 9 files and created 2 new modules unchallenged. Re-running the identical task with a
> working boundary produced **5 files, 0 new modules, and one challenge the agent acted on**. It is
> not deterministic (0 failures in 12 sequential draws) and six concurrent draws produced a
> different failure — `EPERM … rename` on the atomic `task.json` write. Recorded as P2 in
> `REGRESSION-0.2.1.md`.

> **`mcp:test` and `multi:test` also fail on a database holding several projects**, and that is
> a different thing from the flake above — it is reproducible, and it is the one-database-per-repo
> limit biting. Measured 19 Aug with **three** projects loaded (demo, better-auth, dexto):
> `ichor_impact` on the ELEVEN-FILE DEMO took 1,507ms against a 1,500ms budget and fell back to
> "use your own search tools", so 18/20. `multi:test` did not finish inside 600s. Both are
> 20/20 and 10/10 again the moment the database holds one project.
>
> This corrects a claim in `BUGS.md`: *"Three projects work comfortably."* Three projects is
> where retrieval on the smallest of them starts breaching its own budget. Two is comfortable.

## The graph — exact, verified 2026-08-18

Command: `npx tsx scripts/ingest.ts <repo>` against an empty database
(`docker compose down -v && npm run up`).

| Number | Where | Verified |
|---|---|---|
| papermark 1,362 files | README, `index.html`, `docs.html` | ✅ exact (`read:test` metric) |
| 3,471 functions | README, `docs.html` | ✅ exact |
| **21,384 connections** | README | ✅ exact — 21,384 edges written |
| 7,103 nodes | — | ✅ |
| 894 types · 69 routes · 78 models · 1,213 fields | — | ✅ |
| Infisical 7,735 files | README, `index.html`, `docs.html` | ✅ exact |
| Infisical 17,999 functions | — | ✅ (not currently published) |

> **Two file counts exist per repo, and only one is published.** `scripts/analyze.ts` reports
> **1,378** files for papermark and **7,741** for Infisical; `read:test` reports 1,362 and 7,735.
> They count different things — scanned versus analysed as source. **Publish the `read:test`
> figures (1,362 / 7,735)** everywhere, because that is what the file-count claim is about.
>
> This matters beyond the headline: the scope-scorer measurements in `web/docs.html` ("thousands
> of files matched", "18 files of guesswork down to 1") were run over analyze's scan sets, so
> their true denominators are 7,741 and 1,378. The prose now refers to the same repos by their
> published counts instead, because two different counts for one repository on one page reads as
> a typo and the 16-file difference changes none of the claims. The raw denominators are here.

## Call resolution — exact, verified 2026-08-18

Command: `npx tsx scripts/analyze.ts <repo>`

| Number | Value | Where |
|---|---|---|
| call sites, total | **35,264** | not currently published |
| resolved in-repo | 4,164 (11.8%) | — |
| external | 4,986 (14.1%) | — |
| **unresolved** | **7,178 (20.4%)** | README, `index.html`, `docs.html`, film 3 |
| **call sites Ichor attempts to resolve** | **16,328** | README (as "~16,300") |

### The type-checker trade, corrected

The published sentence is: *asking the checker costs ~2.45ms per call site, and a real repository
has ~16,300 of them — about forty seconds.*

```
in-repo 4,164 + external 4,986 + unresolved 7,178 = 16,328
2.45ms x 16,328 = 40.0 s      <- the published figure. Correct.
2.45ms x 35,264 = 86.4 s      <- if all call sites were queried
```

**This previously said 33,000, which was wrong** — not the total, not the attempted count. The
forty seconds was always right; only the count was invented. Rounded to 16,300 in prose.

The 2.45ms per-call cost is inherited from the day-1 spike and has **not** been re-measured. If
it is ever re-run, update it and the 40s together, because they multiply.

## Boundary quality — exact, verified 2026-08-18

Commands: `npx tsx scripts/ground-truth.ts alarms <repo>` and `… measure <repo>`.
Scope: one repository, **30 commits**, **86 changed files** of every type (both ✅ exact —
`.ground-truth/cases.json` holds 30 cases totalling 86 files).

Shipped configuration: `60 anchors, no damping, no hubs, depth 1`.

| Number | Value | Verified |
|---|---|---|
| **real edits wrongly challenged** | **12.8%** (11/86) | ✅ exact |
| real changed code inside the boundary | **68.4%** | ✅ exact |
| median task area | **8.9%** of the repo | ✅ exact |
| worst-case task area | **12.1%** | ✅ exact |

The sweep also reports `60 anchors, no damping, depth 2` at 11.6% false alarms with 72.8% recall
but an 18.9% median area — a wider boundary that challenges slightly less and contains more. It
is not what ships, and the numbers published are the shipped config's. The sweep ends with
*"NOTHING CLEARS THE BAR — report the number, do not move the bar."*

## Speed and memory — ceilings, measured 2026-08-18

Timings are wall clock on one developer machine and will differ on yours. They are published as
approximations for that reason.

| | papermark (1,362 files) | Infisical (7,735 files) |
|---|---|---|
| first index, empty database | **~19s** ✅ re-measured | 2m 21s ⚠️ **not re-verified** |
| second index, nothing changed | 6s ⚠️ **not re-verified** | 16s ⚠️ **not re-verified** |
| peak memory | **under 400 MB** (measured 351 MB) | **under 800 MB** (measured 757 MB) |
| source size | 7.6 MB | 37.8 MB |

Peak memory and file counts come from `npm run read:test -- <repo>`, which reads without writing.
The first-index figure comes from `scripts/ingest.ts` against an empty database, and covers
analysis plus the graph write.

### What still needs measuring

**The second-index figures (6s and 16s) could not be reproduced.** `scripts/ingest.ts` has no
write ledger — it prints *"writing all 21,384 edges the slow way — no record of the last write"*
and takes about as long as the first run. Those numbers come from the CLI's refresh path, which
keeps `.ichor/incremental.json`, so reproducing them needs an `ichor watch` session rather than
the ingest script. **Until that is done, treat 6s and 16s as inherited, not verified.**

**Infisical's index timings were not re-run.** Only its read was measured (65.6s, 7,735 files,
757 MB peak). The `2m 21s` first index is inherited from an earlier session.

---

## How to re-measure everything

```bash
# structural
find src -name "*.ts" | wc -l && cat $(find src -name "*.ts") | wc -l

# suites
npm test && npm run check && npm run session:test
npm run hook:test && npm run mcp:test && npm run multi:test && npm run incremental:test

# the graph, from empty
docker compose down -v && npm run up
npx tsx scripts/ingest.ts <repo>          # edges, nodes, first-index time

# call resolution
npx tsx scripts/analyze.ts <repo>         # total / in-repo / external / unresolved

# files and memory, no write
npm run read:test -- <repo>

# boundary quality
npx tsx scripts/ground-truth.ts alarms <repo>
npx tsx scripts/ground-truth.ts measure <repo>
```

Then diff the output against this file, and this file against `README.md`, `web/index.html` and
`web/docs.html`. Any disagreement is a bug in the prose, not in the table.

---

## 19 Aug — papermark, the first repository where the data layer exists

Command: `ichor watch` on a fresh clone of mfts/papermark at `56815a7`, empty database.

| | |
|---|---|
| files · functions | 1,379 · 3,472 |
| routes | **69** |
| models · fields | **78 · 1,213** |
| `TOUCHES` edges | **1,198** |
| calls · references · imports | 9,792 · 2,414 · 5,516 |
| first index, empty database | **37.7s** |
| merged declarations folded | 0 (`duplicateNames` 5) |

Close to the earlier published figures (3,471 functions, 69 routes, 78 models, 1,213 fields) — the
one extra function is a newer commit, not a change in extraction.

**Route coverage is partial on this repo, and that was not known before.** Ichor extracted 69
routes from 47 App Router files and **zero from 233 Pages Router API routes** — roughly 23% of the
application's endpoints. papermark uses both routers. Recorded as P4 in `BUGS.md`; it bounds what
`ichor paths` can answer here and it is not currently stated in the README.

**This is the first target in four rounds with a usable data layer**, and therefore the first place
test 2 could run at all. better-auth produced 0 `TOUCHES` from 12 models, dexto and opentui
produced 0 routes. Stated plainly because it bounds every earlier round: the new-flow test was
untested on real code until now.

**Same task, with and without a working boundary** — the clearest measurement of what the product
is worth, and it came from a failure rather than a design:

| | boundary failed (P2) | boundary working |
|---|---|---|
| files changed | 9 | **5** |
| new modules | 2 | **0** |
| edits judged | 0 of 30 | all |
| agent changed course after a challenge | — | **yes** |

---

## 19 Aug — measured on two pnpm monorepos, after the regression fixes

`better-auth` (1,340 files, 3,094 functions) and `truffle-ai/dexto` (1,396 files, 5,777
functions) were added as targets because each exposed a failure neither papermark nor Infisical
could. Everything below is exact, produced by calling the package's own `analyzeRepo` and
`hashId` rather than by a reimplementation.

### Call resolution is repo-shaped, and the published trade is not universal

Command: `npx tsx scripts/analyze.ts <repo>`

| | papermark | **better-auth** |
|---|---|---|
| call sites, total | 35,264 | **84,530** |
| resolved in-repo | 4,164 | 9,143 |
| external | 4,986 | 23,955 |
| unresolved | 7,178 | 7,899 |
| **needing the type checker** | — | **40,903 (48.4%)** |
| call **edges** written | 21,384 total edges | **4,034 CALLS** |

**The README's "only 2.5% are `obj.method()`" is a papermark figure, not a law.** On better-auth
it is **48.4%** of call sites, and only **4.8%** of call sites become a CALLS edge. The
consequence is concrete and worth stating rather than hiding: `ichor impact createAuthEndpoint`
reports *"called by nothing in the graph"* while the source contains **304 call sites across 10
packages**. Cross-package imports in a pnpm workspace resolve through `package.json` `exports`
maps and workspace links, which name-and-import-path resolution cannot follow.

The `2.5% / 96.5% / 1%` split stays published **attributed to papermark**, with the better-auth
figure beside it. One repository is not a range.

### The data layer is Prisma-client-shaped

better-auth: **12 models, 109 fields, 0 `TOUCHES` edges.**

`TOUCHES` is emitted for direct Prisma client calls (`prisma.vendor.create()`). better-auth
reaches its data through its own adapter interface, so no function links to a model. Three
consequences, all measured:

- `ichor paths User` and `ichor paths Session` both answer *"Nothing in the graph touches …"*
- `coreModels` is empty, so the classifier loses the discriminator it uses at distance > 0
- **test 2 — the new-flow test — cannot fire at all**

Not a defect in the extractor so much as an unstated scope limit, now stated.

### Declaration merging made a repository un-indexable — fixed

dexto failed at write time, permanently and deterministically:

```
GraphQuery query is not supported yet:
conflicting metadata values for vertex 2802411236362412 property line
```

Cause: `export interface DextoAgentOptions` declared twice in one file (lines 22 and 77 —
ordinary TypeScript declaration merging). Two `TypeFact`s, one key, different `line`, one
`UNWIND` batch, whole statement rejected. **Exactly one id of 8,098 collided.**

| | before | after |
|---|---|---|
| duplicate node ids on dexto | 1 | **0** |
| `ichor watch` on dexto | fails at ~23s | **completes in 24.9s** |
| types extracted | 2,322 | 2,321 (one merge folded) |
| `delta:test` on dexto | n/a — no graph | **✅ CALLS 6,132 · DECLARES 8,098 · IMPORTS 2,900 · REFERENCES 5,704 · ledger 22,834** |

Prevalence across four repos tested: **1 of 4** (dexto). elysia, opentui and better-auth had zero.

### Task-switch detection from prose — fixed

One intent, six phrasings, from an identical freshly-drawn session-cookie boundary on
better-auth. Driven through the real compiled hook, not a unit test.

| prompt | before | after |
|---|---|---|
| `different job now. the rate limiter needs a clearer doc comment…` | NO_SIGNAL (227 files) | **boundary set, 215 fns** |
| `now work on the rate limiter` | NO_SIGNAL (67) | **221 fns** |
| `now work on rateLimiter` | NO_SIGNAL (67) | **221 fns** |
| ``now work on `pruneMemoryStore` `` | NO_SIGNAL (45) | **211 fns** |
| `now work on packages/better-auth/src/api/rate-limiter/index.ts` | NEW ✓ | **16 fns** |
| `switch to rate limiting: fix the purge` | NO_SIGNAL (104) | **88 fns** |
| **worked** | **1 of 6** | **6 of 6** |

Control: a prompt about the same job (`also update the toast copy when a cookie is rejected`)
still changes nothing, which is the outcome that matters — the fix must not make the boundary
skittish.

**Why the union was the wrong thing to measure.** Per-term spread for the first prompt above:

```
limiter    3 places   <- and the first is the exact file meant
entries    2
expired   16
rate      59
doc      135
union    174          <- what the guard used to test
```

The vaguest word in a sentence was deciding the fate of the sharpest one. The guard now judges
the footprint of the *focused* terms and ignores the generic ones; when nothing is focused it
still returns NO_SIGNAL.

### Judge reachability — fixed

`ichor justify <file> "<reason>"` reaches the Judge with no MCP permission. Measured: **29.3s**
for a live verdict with three structural citations, on a claim the graph can refute.

Before, on an untrusted workspace — the default for a fresh clone — the agent was refused
`mcp__ichor__ichor_request_scope_expansion` and the entire negotiation layer was unreachable.
Observed live: five challenges, five silent retries, zero Judge calls.

### Still open, deliberately

Measured and understood, not fixed before submission, because each needs the papermark
ground-truth harness re-run and that repository is not currently on the machine:

- **`matches()` is substring, not segment-aware.** `ichor find "code that decides how long a
  login lasts"` returns `LastLoginMethodClientConfig` — it matched *lasts* inside *LastLogin*.
  The same looseness makes `package.json` CONNECTED for a task naming `packages/…`.
- **Boundary breadth from short prose.** `ichor start "fix the rate limiter memory store
  pruning"` drew **462 functions across 130 files — 14.9% of the repo**.
- **Judge escalation.** A claim about runtime or user behaviour, which its own rules say must go
  to the developer, was refused with high confidence — twice. The published 3/3 was measured on
  the demo and may be model-dependent.
- **Stats after an incremental refresh describe only the delta** — a refreshed `facts.json`
  reported 139 call sites and 4 unresolved beside 4,034 whole-repo edges.
- **A rare filler word counts as a "focused" term**, because the rule measures rarity rather than
  meaningfulness. Pre-existing, not introduced by the task-switch fix; the citation now lists the
  sharpest terms first, but striking fillers from `STOP_WORDS` is anchoring and needs the harness.
