# features.md

What we are building, for learning purposes: **Kestrel** — our own coding agent app that works the way
Claude Code does, wrapped in a Code view, running on our own Gemini / OpenRouter / NVIDIA keys.
Every point below is a requirement with an acceptance check. Nothing here is copied from Claude Code or
the Claude app; the behaviour was studied, then re-implemented in our own code.

---

## 1. The complete harness

The engine must do everything the Claude Code harness does, operating the same way — same order of
operations, same result for the same input, not merely a similar-looking chat.

**Required behaviour**

- **Agent loop.** One user turn drives a loop: send conversation to the model → receive assistant text
  and/or tool calls → run every tool call the model asked for → append results → call the model again.
  The loop continues until the model stops asking for tools. Text and tool activity stream to the UI as
  they arrive, never batched at the end.
- **Tool set.** File read, file write, exact-string edit, multi-edit, glob, grep, directory listing,
  shell command execution (foreground + background), todo list, web fetch, web search, sub-agent task
  dispatch, notebook edit, plan-mode enter/exit. Each tool validates its input, returns a
  structured result (text + metadata), and reports failure as a normal tool result instead of throwing.
- **Tool-result truncation.** Long outputs are truncated with a marker and the full output written to a
  temp file that the model can read, so a single huge command cannot blow the context window.
- **Permissions.** Every tool call is classified (safe / needs approval / blocked). Approval requests
  surface in the UI and block the loop until answered, with allow-once, allow-for-session and deny.
  Rules match on tool name plus path or command pattern.
- **Modes.** Default (ask), accept-edits, and plan (read-only, must exit plan before writing). The mode
  is visible at all times and included in the system prompt sent to the model.
- **Context management.** Token counting, automatic compaction when approaching the limit, and a
  summary that preserves the current task, files touched and open decisions.
- **System prompt.** Assembled per session from: identity, environment (cwd, platform, date, git
  status), tool instructions, mode, and project memory. It is our prompt, written by us.
- **Sessions.** Every conversation persists with id, title, cwd, model, message history, tool calls and
  token/cost totals. Resume, rename, delete, and continue-after-restart all work.
- **Slash commands.** At minimum: `/help`, `/clear`, `/compact`, `/model`, `/mode`, `/init` (write memory
  file), `/cost`, `/resume`, `/quit`, plus user-defined commands loaded from a commands folder.
- **Project memory.** A memory file per project is read into the system prompt at session start and can
  be created or updated by the agent.
- **Usage accounting.** Input tokens, output tokens, cache reads, and an estimated cost per turn and per
  session, displayed live.
- **Interrupts.** Stop mid-stream; the partial assistant text is kept and the tool queue is dropped.
- **Errors.** Provider errors, rate limits and malformed tool calls are surfaced as readable chat events
  and never crash the session.

**Acceptance check.** A scripted end-to-end run with the pretend model exercises the loop, every tool,
a permission grant, a permission denial, a mode switch, compaction, resume-after-restart, and an
interrupt. All results match the expected transcript.

---

## 2. The Code view

The desktop app around the engine is the Code view, matching the real one's information architecture.

**Required panels**

- **Sidebar** — session list (title, relative time, cwd), new-chat button, search, project grouping.
- **Top bar** — project/workspace name, current model, mode selector, usage readout, window controls.
- **Transcript** — user messages, assistant prose rendered as markdown, and a card per tool call
  showing tool name, target, status (running / ok / error), collapsible output, and its diff when it
  edited a file.
- **Composer** — multiline input, send/stop, `@` file mentions, `/` command palette, image attach,
  mode shortcut, and a queue for messages typed while a turn is running.
- **Changes panel** — every file the agent touched this session, with a side-by-side or unified diff,
  accept/revert per file, and open-in-editor.
- **Terminal panel** — the live output of the shell commands the agent ran, plus an interactive shell
  per session.
- **Status bar** — connection state, streaming state, token/cost totals, cwd.

**Acceptance check.** Every panel is reachable by keyboard, updates live during a turn, and reflects
real state (no placeholder text anywhere).

---

## 3. Visual match, at least 90%

It must look at least 90% like the Code view: same layout, same panel arrangement, same sizes, same
flow.

- Typography scale, weights, line heights and monospace usage match within a few percent.
- Panel widths, header heights, corner radii, borders and dividers match the reference.
- Colour roles (background layers, borders, text tiers, accent, danger, success) sampled from reference
  screenshots and matched within a small delta.
- Icon set and placement match; message and tool-card spacing match.

**Acceptance check.** Side-by-side screenshots of our app and the reference at the same window size are
compared with REA's image analysis; the measured difference must be reported as a parity percentage,
and it must reach 90% or better. The number is recorded in CHECKLIST.md.

---

## 4. Our own keys, any of their models, plus the real Claude Code

- **Keys screen** where the user pastes a Gemini key, an OpenRouter key and an NVIDIA key. Each key is
  validated with a real request, then stored encrypted outside this folder. Keys are displayed masked
  after entry and can be replaced or deleted.
- **Model picker** lists the models each provider actually offers (fetched from the provider at runtime,
  cached), with context length and pricing where available. Any of them is selectable, and the choice
  persists per session.
- **Provider adapters** normalise streaming chat, tool calls and tool results across the three APIs, so
  the harness code is provider-agnostic.
- **Real Claude Code option.** A provider mode that runs the installed `claude` CLI as a subprocess in
  print/stream mode and maps its events into our transcript, so the same UI can drive the real tool.

**Acceptance check.** With one key of each provider present, a tool-using prompt completes a full
agentic turn on at least one model per provider. The Claude Code mode runs a real turn through the CLI.

---

## 5. Fast

- Cold start to an interactive window in **under 2 seconds**, measured from process start to first
  paint and logged by the self-check.
- Reply text appears as each chunk arrives — no buffering, no re-render of the whole transcript per
  token, no artificial debounce.
- Tools that do not depend on each other run concurrently; provider/model lists, diffs and old
  transcripts load lazily.
- The renderer stays responsive during a turn (no long tasks over 50 ms in the main thread).

**Acceptance check.** The self-check records start time and memory, and asserts first-paint under 2 s
and first-token latency under 300 ms against a local pretend model.

---

## 6. Our own name and icon

- The product is called **Kestrel** everywhere: window title, app menu, about box, installer, data
  folder names.
- Our own icon (SVG source plus generated PNG/ICO), used for the window, the desktop shortcut and the
  installer.
- **No** Claude or Anthropic name, logo, colour mark or asset anywhere in the UI, docs or icons. The
  only permitted mention is the explicitly labelled "run the installed Claude Code CLI" integration,
  which names the external tool the user chose to run.

**Acceptance check.** A repo-wide text and file scan finds no Claude/Anthropic branding outside that one
labelled integration, and the packaged app shows the Kestrel name and icon.

---

## Part 1 status (what a check actually shows)

Evidence: `checks/summary.json` plus `checks/runs/<timestamp>/` (window screenshots, per-step timings,
memory) from `node app/selfcheck/run.js`.

**Built and proven by a run**

- Agent loop with streaming text, sequential approval decisions and concurrent tool execution
  (`app/engine/loop.js`).
- Tools: read, write, edit, multi_edit, ls, glob, grep, bash (foreground + background), bash_output,
  bash_kill, todo_write, web_fetch, web_search (disabled, returns a clear error).
- Permission dialog with allow once / allow for session / deny; four modes; plan mode hides writes.
- Sessions: create, list, open, rename, persist, resume after a renderer restart, per-session edits,
  terminal log and usage totals.
- Window: sidebar, top bar with provider/model/mode pickers, transcript with tool cards, composer,
  Changes panel with diffs, Terminal panel, status bar, Keys screen with three providers.
- Encrypted key store: AES-256-GCM in the user config dir, 0600 machine key, masked reads, plaintext
  never written (`app/selfcheck/keystore-check.js`).
- CLI print mode: `kestrel -p "..." --output-format text|json|stream-json`.
- Self-check harness: launches the real app on a private display, drives the real DOM, screenshots
  every failure, records start time and memory, exits with a status.

## Part 2 status

Added and proven by the same run (20 steps, 0 errors): slash commands including `/help`, `/init` and
`/compact`; context compaction that shrank a 22-message transcript to 3 with a recorded summary; an
interrupt that keeps the partial reply (8 of 83 characters kept) and drops its unfinished tool calls;
read-only sub-agent dispatch through the `task` tool; `notebook_edit` against a real `.ipynb`; and
`enter_plan_mode` / `exit_plan_mode` round-tripping the mode. The CLI handles slash commands too
(`cli.js -p "/help"`).

Also proven since: a denied permission (`permission-denied` — the file is never created, the model is
told "permission denied", and the turn still finishes) and a real shell command (`shell-command` —
`echo kestrel-shell-ok`, exit 0, visible in the Terminal panel with a screenshot).

Still open from this part: user-defined commands are loaded and expanded but the check does not invoke
one, and automatic compaction is wired but the short self-check turns never approach the limit.

## Part 3 status

Claude Code subprocess mode works: choosing the **Claude Code (CLI)** provider spawns the installed CLI with
`-p --output-format stream-json --verbose --include-partial-messages`, and its events become Kestrel
events — init notice (version, model, tool count), streamed text, tool cards with their results, usage
and cost. Because the CLI is a harness of its own, Kestrel does not re-run its tools in this mode.

Proven twice in one run: against the **real** binary, which prints its init line for 2.1.316 and then
reports `Not logged in · Please run /login` (surfaced as a readable error), and against a **stub** CLI
that speaks the same stream format, exercising text streaming, a `Read` tool card with its output, 42
input tokens and $0.0004 of recorded cost.

Permission requests are bridged: the CLI runs with `--input-format`-free `--permission-prompts host`, sends
`control_request`/`can_use_tool` on stdout, and Kestrel answers on stdin with the user's decision from its
own dialog (allow, allow-for-session, deny). Two steps prove both directions — an allowed write really
reaches disk, a denied one never does.

Known limits of this mode: the CLI is stateless per run, so earlier turns are replayed into the prompt;
a logged-in turn has not been observed because no login exists on this machine. Allow-for-session is
proven: two requests for the same tool in one turn produce exactly one dialog, and the second is
answered from the session rule.

**Written but not run against a real service**

- Gemini, OpenRouter and NVIDIA adapters (streaming chat, tool calls, model lists, key validation).
  No key exists in this environment, so no live turn has been made; each provider's endpoint and
  request shape was checked against its public API documentation.
- Claude Code subprocess mode, sub-agent task dispatch, notebook edit, plan enter/exit, slash commands,
  compaction, cost estimates, interrupt-with-partial-text: not implemented yet (Parts 2 and 3).
- Visual parity against the reference cannot be measured here: the desktop app is not installed on this
  machine (recorded as `unknown` in SPEC.md).
