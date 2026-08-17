# Engineering rules

Six days, one person, a public repo that judges will read. These rules exist to stop the two ways this fails: **shipping something that isn't true**, and **shipping nothing because we gold-plated the foundations.**

Read this before writing code. It is short on purpose.

---

## 1. The truth rule — structure is compiled, intent is reasoned

> **Every edge in the graph must be traceable to a line of source code.**

Ichor's authority comes from being right about structure. When it says *"the existing submit path already reaches the uniqueness check,"* that has to be a fact, not a guess — otherwise the agent is being challenged on a hallucination, and one spot-check destroys the whole submission.

There is a hard line down the middle of this system:

| | Decided by | Never decided by |
|---|---|---|
| **Structure** — what calls what, what a route reaches, what touches a model | the TypeScript compiler | an LLM |
| **Intent** — is this expansion justified for *this task* | the Judge (LLM), with the graph as evidence | — |

Therefore:

- **No LLM resolves code relationships.** Not for call targets, not for "what does this function probably do", not to fill a gap. If the compiler cannot resolve a call, we **drop the edge and count it** rather than approximate it.
- **The Judge never invents structure.** It receives graph facts and the agent's explanation, and reasons about whether the expansion is warranted. It cannot add a node or an edge.
- **Every challenge carries its evidence** — the path, with file and line for each hop, or the existing path that already satisfies the requirement. If we cannot cite it, we do not challenge.
- **The agent's confidence is not evidence.** A convincing explanation with no structural support is still unjustified.

## 1a. Silence is a feature

False positives are the way this product dies. A tool that questions every third edit gets uninstalled the same afternoon.

- Challenge only what is **clearly** outside the neighbourhood. When uncertain, stay silent.
- Catching three genuinely unnecessary expansions beats flagging thirty questionable ones. **Precision over recall**.
- Graph first, LLM second. Obviously-expected and strongly-connected edits must never reach the Judge — that is both correctness and cost control.

## 2. Fail loud, never silently

Silent truncation is the specific way this class of tool lies. It is also a known behaviour of the engine we're building on: HydraDB's `pathCount` **silently truncates** path results, which manufactured a false statistical result for another team this week.

- If a limit is hit — `maxLen`, `pathCount`, a batch cap, an unresolved import — **say so in the output**. `"12 paths (truncated at 20 — raise --path-count)"`, never a bare `12`.
- Unresolved things get **counted and reported**: `"resolved 8,431 of 9,102 call sites (94%); 671 unresolved (dynamic dispatch)"`. That number goes in the README and on camera. It is a credibility builder, not an embarrassment.
- Prefer a thrown error over a wrong answer. A crash is debuggable; a plausible wrong number is not.

## 3. One place for load-bearing decisions

Some decisions are impossible to change later. Each gets exactly one module, and nothing else may reimplement it:

| Decision | Owner | Never do this elsewhere |
|---|---|---|
| String key → integer node id | `src/ids.ts` | Never hash inline. Never `Math.random()`. Never a counter |
| Talking to HydraDB | `src/graph/client.ts` | Never construct a driver anywhere else |
| Cypher we send | `src/graph/queries.ts` | Never build Cypher by string concatenation in feature code |
| Classifying an edit | `src/scope/classify.ts` | Never re-implement the two tests in a hook or the MCP server |
| Talking to the model | `src/judge/` | Never call OpenRouter from feature code |

**The hook and the MCP server are thin.** They translate a host-specific event into a `ChangeIntent` and hand it to the scope engine. All reasoning lives in `src/scope/`, so that adding Cursor later is an adapter and not a second brain.

**Node ids must be non-negative integers** (HydraDB requirement) and **stable across runs** (diff mode compares two graphs — an unstable id makes every node look new). `ids.ts` also asserts that two different keys never collide onto the same id, and throws if they do.

## 4. Cypher discipline — HydraDB is a subset, not Neo4j

These are rejected at parse time. Knowing them now saves a day of confusion:

- **no `IN`, `CONTAINS`, `ENDS WITH`, `IS NULL`** in `WHERE` — filter in TypeScript instead
- **no `min` / `max`** — only `count`, `sum`, `avg`, `collect`. Use `ORDER BY … LIMIT 1`
- **no `RETURN *`** — name every projection
- **no undirected patterns**, and **one relationship type per pattern**
- **variable-length traversal must be bounded** — `*1..8`, never `*`
- **`WITH` is pass-through only** — no aliasing or filtering, so multi-stage logic lives in TypeScript across several single-statement queries
- **one statement per request**
- Batch writes only via `UNWIND $rows` **over the Bolt driver** (the in-process API rejects it with a misleading error)

Anything needing whole paths, multiple relationship types, or undirected traversal must go through `algo.SPpaths` / `SSpaths` / `MSpaths`.

## 5. Code style — deliberately boring

- **TypeScript, `strict: true`.** No `any` in committed code. If a type fights you, `unknown` plus a narrow.
- **Functions over classes.** A class earns its place only when it owns real lifecycle state (the graph client does; nothing else so far).
- **No abstraction until the third use.** With six days, a premature interface is a pure loss. Duplicate twice, extract on the third.
- **No barrel files** (`index.ts` re-exports). Import from the real path so a reader can follow it.
- **Pure where possible.** Extraction returns data; only `graph/write.ts` performs I/O. This is what makes the extractor testable without Docker running.
- **Name things after the domain**: `Route`, `Function`, `Model`, `Field`, `CallEdge`. A reader should map code to the graph model without a decoder ring.
- Comments explain **why**, never what. The compiler already says what.

## 6. Testing — proportionate, not religious

No coverage targets. Two kinds of test earn their keep:

1. **The fixture test (non-negotiable).** A tiny hand-written TypeScript app in `test/fixtures/` where we *know* the correct answer: routes, call chain, Prisma calls, and one deliberately deep path. Every extractor change runs against it. **This is how we know the graph is true**, and it is the thing that lets us claim accuracy on camera.
2. **Unit tests for load-bearing pure logic** — `ids.ts` (stability + collision), path assembly, diff set logic.

No tests for glue, CLI wiring, or formatting. No mocking of HydraDB — the fixture test hits a real one.

## 7. Commits — the judges read these

Submission rules: **no participant-authored commit before 12 Aug 2026**, and organisers may inspect history.

- Small, meaningful commits with real messages. `wip`, `fix`, `asdf` are not acceptable in a repo that is part of the submission.
- Conventional style: `feat(extract): resolve call targets through re-exports`.
- **Never** commit a `.env`, an OpenRouter key, or MinIO credentials beyond the dev defaults.
- Commit steadily. A repo with one enormous commit on day 6 looks exactly like a repo that broke the start-date rule.

## 8. Attribution — a disqualification risk, not a nicety

The rules require attribution for third-party libraries, APIs, datasets and open-source code, plus an open-source licence. Ichor has both a licence and a Credits section in the README from day one.

> ⚠️ **No code from Graphify, or any other prior work, enters this repo.** Applying experience is fine and worth saying out loud. Copying code is a start-date and licensing violation. Everything here is written fresh, after 12 Aug 2026.

## 9. Scope discipline

`SCOPE.md` holds the cut list. It was decided calmly, in advance, so it can be honoured under pressure at 2am on day 5.

- Changing scope after day 2 needs a written reason in `SCOPE.md`.
- "While I'm in here I'll just…" is how the deadline is missed. Write it down, move on.
- **Day 4 (diff mode) is protected.** It is the differentiator. Nothing gets borrowed from that day.

## 10. Definition of done, per feature

1. It runs on the fixture and gives the known-correct answer
2. Limits and unresolved counts are reported, not swallowed
3. The README says what it does and what it cannot do
4. It is committed with a message a stranger can follow
