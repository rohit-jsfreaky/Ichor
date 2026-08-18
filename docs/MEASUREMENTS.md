# Measurements

Every number Ichor publishes, the command that produces it, and what it measured to.

**This file is the source of truth.** If a number appears in `README.md`, `web/index.html`,
`web/docs.html` or a source comment, it must appear here first. If they disagree, this file is
right and the other one is a bug.

Last full re-measure: **2026-08-18**
Targets: `papermark` (a real document-sharing product) and `Infisical` (the largest repo tested).

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
| unit | 178 | `npm test` | ✅ 178 passed |
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
