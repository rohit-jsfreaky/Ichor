# Ichor

**Make every scope expansion explicit while AI coding agents work.**

You ask Claude for a small fix. It starts correctly. Then it adds an endpoint, introduces an abstraction, refactors a helper, touches authentication, rewrites a test — and twenty files later you are reviewing a change you never asked for.

Ichor notices that **while the agent is still working**.

```
You:    Fix duplicate email handling in vendor onboarding.
        Don't return a 500, show a toast, keep the form data.

Claude: edits the submit handler        Ichor: ✓ within scope
Claude: edits the form error handling   Ichor: ✓ within scope
Claude: creates /api/vendors/check-email

Ichor:  ⚠ Scope expansion.
        The existing submit handler already reaches the email
        uniqueness check:
          VendorForm → submitVendor → createVendor → uniqueness check
        A separate check-email endpoint introduces a second
        validation flow. Why is it required?

Claude: It isn't. I'll handle it in the existing submit flow.
```

Three files changed instead of twenty.

---

> **Status: day 1 of 6.** Foundations only — the analyser and scope engine are being built now. This README describes where it is going. Built for [Hack Hydra](https://hackhydra.hydradb.com/), Track 02.

## Why this needs a graph

A task is almost never one file. *"Change invite expiry from 24 to 48 hours"* might live across an invite page, an action, a service, a token helper, a config constant, a database model and a test — files that share no vocabulary and no folder.

So the boundary cannot be `/src/vendors/**`, and it cannot be "files similar to the task description" either. The only thing that actually connects those files is **the structure of the program**, which is why Ichor keeps the codebase in [HydraDB](https://github.com/hydra-db/hydradb) and reasons over the connected neighbourhood of the task.

The graph is not the product. It is the evidence.

## How it decides

Two independent tests:

1. **Is this edit connected to the task?** — reachability from the task neighbourhood.
2. **Does an existing path already do this?** — the new-flow test.

The second one is the interesting half. A new `/check-email` endpoint *is* connected — it imports Prisma, looks up a vendor by email, sits with the other vendor routes. It is unnecessary because the existing submit path already reaches the uniqueness check. No permission system or linter can make that call.

## Not a blocker

Ichor is not a file fence. Edits are classified as:

| | |
|---|---|
| **EXPECTED** | inside the neighbourhood — silent |
| **CONNECTED** | just outside, strong path back — expand automatically, silent |
| **SUSPICIOUS** | weak or no connection — ask the agent why |
| **JUSTIFIED** | agent explained, graph supports it — expand |
| **HUMAN REVIEW** | cannot be validated — ask the developer |

**Silence is the normal state.** A hard blocker that fires on every third edit gets uninstalled in ten minutes.

The agent can argue. The graph provides evidence. The human decides when it stays ambiguous.

## Quick start

```bash
npm i -g ichor-cli

cd your-repo
ichor init                                   # starts HydraDB locally, installs hooks
ichor start "fix duplicate email handling"   # works out the task neighbourhood
```

Then run Claude Code or Codex as usual.

**Requirements:** Node 20+, Docker, and a TypeScript repo — ideally Next.js + Prisma.

## Your code never leaves your machine

Ichor runs HydraDB and MinIO locally through Docker. The graph of your codebase — every function, route and model name — stays on your disk. Nothing is uploaded, and there is no account.

## Supported agents

| Agent | Level | How |
|---|---|---|
| **Claude Code** | Full | `PreToolUse` hook — challenges *before* the edit is written |
| **Codex CLI** | Full | `PreToolUse` hook — same mechanism |
| Cursor · Windsurf · Gemini CLI · Cline | Coming soon | Same adapter interface |

Both supported agents also get an **MCP server**, so the agent can ask why something was flagged and argue its case rather than just being refused.

## What it cannot do — please read

- **TypeScript / JavaScript only.** Python is next; nothing else is claimed.
- **Static analysis.** Dynamic dispatch and runtime-constructed calls are invisible.
- **Edits written through shell commands are not seen.** Ichor hooks the agents' edit tools; a file written by `cat >` or a codegen script bypasses it.
- **The initial task boundary is an expectation, not a fact.** It is designed to grow as the work justifies it.
- **Ichor can be wrong.** When it cannot validate a justification it asks the developer rather than deciding.

## Roadmap

Python analyser · cross-language repositories · Cursor / Windsurf / Gemini / Cline adapters · team history ("what does a task like this normally touch here?") · Ichor Cloud for teams.

## Credits

- [HydraDB](https://github.com/hydra-db/hydradb) — object-store-native graph database (AGPL-3.0)
- [ts-morph](https://ts-morph.com/) — TypeScript compiler API wrapper
- [neo4j-driver](https://github.com/neo4j/neo4j-javascript-driver) — Bolt client
- [MinIO](https://min.io/) — S3-compatible object storage
- [OpenRouter](https://openrouter.ai/) — model routing for the Judge

## Licence

MIT — see [LICENSE](LICENSE).
