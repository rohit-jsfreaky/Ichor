# Ichor — gate file changes made through Bash

## Context: what actually happened (verified from session transcripts, not inferred)

"Yesterday it worked, today Claude edits via Bash" is real, and it is **not something we broke**.
The evidence, from reading every session transcript in
`~/.claude/projects/D--my-projects-web-projects-pannly-frontend/`:

1. **What changed between the two test days was a server-side flag, not a
   client update.** (A client-version reading was the first hypothesis and it
   was wrong.) Sessions on the SAME version 2.1.233 both HAVE the steer (this
   planning session: Opus 5, 3 injections on Aug 18) and LACK it (Aug 15 and
   Aug 17 sessions: Opus 5, zero). It is a remote rollout that flipped on
   during Aug 18, correlated with Opus models. Each affected session carries an
   `auto_mode` attachment rendering this instruction (found verbatim inside the Claude Code binary; the text itself is
   never written to the .jsonl, only the attachment):

   > While auto mode is active:
   > Do your work through the Bash tool wherever it can accomplish the job: read
   > files with cat, head, or sed -n, search with grep and find, and make file
   > changes with sed, heredocs, or short scripts, rather than using the
   > dedicated Read, Edit, or Write tools. Fall back to a dedicated tool only
   > when Bash genuinely cannot do the job.

2. **No failed Edit ever taught Claude to avoid the tool.** The failing session
   contains zero errors and zero Edit/Write attempts — it went straight to
   `python - <<EOF` heredocs, exactly as instructed. Ichor never denied anything
   in this repo (`challenged: []`), never crashed (fails open by design), and the
   installed build is intact.

3. **Three controls prove it.** (a) Headless `claude -p` runs (no steer) used
   Edit ×3 on the same repo the same day. (b) A fresh repo with NO ichor
   (D:\techorigins\clarix, auto mode) ran **Fable 5** — its transcript contains
   **zero** `auto_mode` attachments, and it used the Edit tool for a CSS change
   Bash could trivially have made. A sweep of all 24 interactive auto-mode
   sessions shows Fable 5 has NEVER received the steer across 4 versions
   spanning a month, Opus 4.8 had it in July, and Opus 5 received it only on
   Aug 18 — on a version that had previously run without it. A flag outside
   anyone's local control that can toggle with no client update. (c) The one Aug 18 Opus session that
   still used Edit had ~10× the thinking budget per message (6,380 thinking
   tokens vs ~600) — enough to reason its way to the "fall back to a dedicated
   tool" escape hatch. Low effort takes the steer literally.

4. **The consequence lands on Ichor.** Its PreToolUse matcher is
   `"Edit|Write|MultiEdit|apply_patch"` — Bash is not in it. Its own log records
   4 out-of-band writes in this repo, including two to `lib/api/uploads.ts`, the
   exact file the task named, which would have passed as EXPECTED. The Stop
   handler catches them only after the turn is over, and only into a log file.

5. **Our injected briefing makes the gradient worse.** Every turn it says
   *"An edit to a file outside the job will be questioned"* while showing 8 of 22
   in-scope files and pointing at an MCP tool whose schema may not be loaded.
   Edits carry a stated cost; Bash writes are free. The briefing is harsher than
   the actual enforcement (the deny text says "explain why and proceed").

**Conclusion:** covering Bash writes is not a workaround — for any model whose
flag is on (today: Opus 5 in auto mode, i.e. what a hackathon judge most likely
runs), the harness instructs Bash for edits, and Ichor's gate watches a road the
agent was told not to take. Which models have the flag changes remotely over
time, so Ichor cannot condition on it. The correct fix is a second gate: after
each Bash command, detect what actually changed on disk, judge it with the same
classifier, and challenge before the agent moves on.

## Design

**Principle unchanged from the rest of the codebase: fail open everywhere.** The
gate is post-hoc by necessity (the bytes are on disk before it runs), so it never
prevents anything — it challenges before the agent moves on, marks the file
judged/challenged exactly like the PreToolUse path, and asks once per file.

### 1 · `gitChangedEntries` in `src/refresh/refresh.ts`

Extract from the existing `gitChangedPaths()` (refresh.ts:142) a variant that
keeps the two-char git status code (`??` create / `D` delete / edit), and
reimplement `gitChangedPaths` on top of it. Pure refactor; stop.ts and
needsRefresh untouched; existing tests must stay green.

### 2 · New module `src/hook/bashGate.ts` — detection + judge loop

State: `.ichor/bash-gate.json` via the existing `writeAtomic` —
`{ version, taskStartedAt, lastCheckAt, seen: {path: {mtimeMs, size}} }`.
Kept OUT of task.json so the per-shell-call hot path never contends with
markJudged/markChallenged; self-invalidates when `task.startedAt` changes.

Detection (target <150ms when nothing changed — the common case):
1. no task → allow (1 JSON read)
2. one `git status --porcelain` spawn (~50–300ms; 3s timeout → fail open)
3. per entry: skip if already accounted (judged∪challenged∪justified∪forced∪
   overlay — the same set `unseenEditDetails` in stop.ts:70 builds); deletes →
   overlay + markJudged, never challenged (parity with the PreToolUse delete
   branch); mtime older than task start minus 2s slack → pre-task dirt, record
   and skip; `seen[path]` matches current mtime+size → already gated, skip
   (the high-water mark that makes repeat calls cheap); previously
   challenged/justified → markForced, skip (push-through semantics)
4. no candidates → save gate state, exit 0 — no graph client, no task.json write
5. refresh in progress → allow WITHOUT recording seen (re-detected next call)
6. judge loop, 5s deadline (same TIME_BUDGET as PreToolUse): read file from disk
   (the write already happened, so disk IS the proposed content — `wholeFile:
   true` is honest and keeps shrinkingSurface armed), `parsePending` +
   `classify()` unchanged, recordOverlay + markJudged; on challenge →
   markChallenged and emit

`.ichor/` and node_modules invisible for free (gitignored). Non-analysed types
(.json/.css) filtered exactly as today. Files outside the repo cannot appear.

### 3 · Routing in `src/hook/run.ts` + the emission channel

- `isShellTool` in `src/hook/input.ts` beside EDIT_TOOLS:
  `new Set(['Bash', 'PowerShell'])`.
- New branch after the Stop branch: `PostToolUse` + shell tool →
  `handlePostShell`, else allow.
- Challenge text: existing `formatChallenge()` verbatim, prefixed with one
  honest line — "The command you just ran changed <file>, which Ichor judged
  after the fact."
- **Emission (the one genuinely uncertain part):** current hook docs say
  PostToolUse exit-2 stderr "shows stderr to Claude" and no longer document
  `decision:"block"`. Emit ONE JSON object carrying both channels —
  `{"decision":"block","reason":…,"hookSpecificOutput":{"hookEventName":
  "PostToolUse","additionalContext":…}}` via the existing `writeStdoutSync` —
  with an `ICHOR_POST_CHANNEL=json|stderr` env switch in a single emitter
  function so flipping to exit-2/stderr is config, not refactor. Real-Claude
  verification (step 7) decides. Worst case is silence = fail open, never a
  false block.

### 4 · Install: `src/hook/install.ts`

Add to EVENTS (install.ts:116): `{ name: 'PostToolUse', matcher: 'Bash|PowerShell' }` →
merged into `.claude/settings.json` as
`"PostToolUse": [{"matcher":"Bash|PowerShell","hooks":[{"type":"command","command":"ichor hook"}]}]`.
Merge discipline unchanged; re-running `ichor init` on an old install adds only
the missing event.

**DECIDED: Claude Code only — Codex config is not touched.** `EVENTS` is currently
shared by both writers, so the entry needs a per-agent scope (e.g. an
`agents: ['claude']` field on the event, honoured by the Codex writer). Codex is
unaffected by this problem: the shell steer is Claude-only, and Codex edits via
`apply_patch`, which Ichor already gates. Writing an event Codex may not
recognise is risk with no upside. Existing Codex behaviour must be byte-identical
after this change — assert it in install tests.

Old binary + new settings also no-ops (fails the tool gate → allow) — safe in
both upgrade orders.

### 5 · Wording (the incentive-gradient fix)

- `scopeBriefing` (prompt.ts:319): "An edit to a file outside the job will be
  questioned…" → "Any file change outside the job will be questioned — made
  with an edit tool or a shell command alike; Ichor asks once per file." This
  removes the asymmetry that made Bash the free road.
- `describeUnseen` (stop.ts:133): "(written outside an edit tool, so no hook
  fired…)" is no longer accurate → "written outside any gated tool — an editor,
  a detached process, or a shell command Ichor could not judge in time".

### 6 · Tests

- `test/bashGate.test.ts` (modeled on unseenEdits.test.ts — tmpdir git repo, no
  graph): detects a shell-written .ts; skips accounted files; skips pre-task
  dirt; seen-mark suppresses identical mtime+size and re-detects after a second
  write; delete → delete; state discarded on task change; corrupted state file
  → reseed not crash; create vs edit from `??` vs modified.
- `test/install.test.ts`: PostToolUse merged; user's existing PostToolUse hooks
  preserved; idempotent; 3-event install upgrades to 4.
- `scripts/hook-test.ts`: out-of-scope disk write + PostToolUse payload →
  challenge on stdout; re-send → allowed (ask once); nothing changed → allowed
  fast (log the inner ms); in-scope write → allowed and in task.judged.
- `scripts/session-test.ts`: a bash-gated file no longer shows up as unseen at
  Stop.
- Full regression: 198 unit + check + hook + session + multi + incremental +
  mcp suites, and papermark ground truth (must stay 12.8% / 68.4% / 8.9% —
  classify() is untouched, so any drift means a mistake).

### 7 · Real-Claude verification (the decisive test, per Rohit's rule: test in
real Claude, not scripts only)

In pannly (Opus 5, auto mode, low effort — the exact failing configuration):
prompt a small task, let Claude write via bash heredoc, then confirm in
`.ichor/hook.log`: `--- PostToolUse` fires, the out-of-scope case produces a
challenge Claude visibly responds to before continuing, the in-scope case
passes silently, and note WHICH channel surfaced (decides the step-3 switch).
Then the reverse control in a repo without the steer (Fable 5) to confirm no
behavior change for Edit-tool sessions. Revert all test edits after (stash or
checkout; never commit).

### 8 · Docs honesty pass

- README line 49: "Before the write lands, as a PreToolUse hook" → "Before the
  write lands (edit tools); immediately after the command and before the agent
  continues (shell writes), as PreToolUse + PostToolUse hooks."
- README line 242 limitation bullet: shell writes ARE now challenged right
  after the command; the residual gap is your own editor / detached processes,
  still named at end of turn. Post-hoc means the bytes are on disk when the
  question is asked — say so plainly.
- `docs/MEASUREMENTS.md`: no numbers change; add the new suites to the table.
- Version bump to 0.1.3. Rohit commits and publishes — never done by me.

## Order

1. refresh.ts refactor (tests stay green) → 2. bashGate detection + unit tests
→ 3. run.ts routing + emitter → 4. install.ts + tests → 5. hook/session tests
(needs build + HydraDB) → 6. wording + README → 7. real-Claude verification in
pannly, flip channel if needed → 8. full regression + ground truth re-run.

## Risks, stated plainly

- **Feedback channel uncertainty is the big one** — docs dropped
  `decision:"block"` for PostToolUse. Mitigated by dual-field emission + env
  switch + live verification; failure mode is silence (fail open), never a
  false block.
- git status on ~8k files may exceed the 150ms target on cold NTFS caches; the
  3s timeout fails open, and `git config core.untrackedCache true` is the
  documented perf note. Timing logged per call so overruns are diagnosable.
- Parallel shell calls in one message: last-writer-wins on bash-gate.json can
  cause duplicate judging (never duplicate asking — challenged lives in
  task.json). Accepted.
- A file judged via Edit then modified via Bash is skipped by the accounted
  set — consistent with "asks once per file", deliberate coarseness.
- Codex is deliberately untouched (decided): no new event written to
  `.codex/hooks.json`, existing behaviour must be byte-identical.
