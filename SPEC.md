# SPEC.md — Kestrel

A study of the **Claude Code harness** (the engine) and the **Code view** of the Claude desktop app,
written so we can rebuild the behaviour in our own code. Every item is marked:

- **seen** — I directly observed it in a source listed below (help text, shipped schema, extracted
  payload, command output).
- **guessed** — inferred from adjacent evidence; plausible but not observed.
- **unknown** — could not be observed in this environment; the reason is always given.

Nothing below is copied code or copied instructions. Behaviour was observed, then described in our own
words. The raw captures stay in `study/` (untracked) and are never shipped.

---

## 0. Method, sources, and the limits of this study

**Environment.** Linux x64 VM, Node 26.13.0, Claude Code CLI **2.1.316** installed globally as a
**native single-file binary** (311 MB, not stripped) at
`/usr/local/nvm/…/@anthropic-ai/claude-code/bin/claude.exe`. No display, no Xvfb, no Electron, and the
Claude desktop app is **not installed**, so the desktop Code view could not be run or screenshotted.

**Sources actually used**

| Source | What it gave |
|---|---|
| `claude --help` and 15 subcommand helps (captured to `study/cli-captures/`) | the whole CLI surface: flags, modes, output formats, subcommands |
| `claude doctor` | install method, auto-update channel, managed-settings policy lookup |
| `claude mcp list`, `claude config list` | MCP registry state; config requires sign-in |
| `sdk-tools.d.ts` shipped in the package (90 declarations) | the real tool inventory with input and output shapes |
| Embedded payload carved from the binary at ~148–156 MB (`study/claude-cli/harness-strings.txt`) | tool one-liners, permission-mode names, hook events, settings paths, slash commands, compaction and context accounting, subagent guidance |
| `study/cli-captures/print-run.txt` | print mode fails here: `Not logged in · Please run /login` |

**Engine use and what it cost.** REA was used only for what the sources above could not show.
`analyze_javascript_application` does not apply — the harness ships as native code, not JS.
`inspect_binary_layout` needs a caller-supplied Python with pwntools/pyelftools/Unicorn; I installed
them into `study/venv` and re-ran it, but the 311 MB binary exceeds REA's 33.5 MB `input_bytes`
ceiling, so **layout inspection of the whole binary is blocked**. `inspect_elf_notes` refuses anything
over 64 MiB for the same reason. Hopper, Ghidra, IDA and Kuna are not installed; decompilation would
need Ghidra plus a JDK (~700 MB) and is unnecessary for a behaviour-level spec, because the tool schema
and the embedded payload already answer the inventory questions.

**Hard limits on this study**

1. **No authenticated run.** There is no Anthropic key and no sign-in, so no real turn, no streaming
   capture, no permission prompt and no session resume could be observed live. Items that need a live
   run are marked `unknown`, not guessed.
2. **No desktop app.** The Code view's layout, panels, sizes and flow are `unknown`. I can describe what
   the app must do from the harness's own vocabulary (`/config`, `/status`, diffs, terminal, sessions),
   but I have not seen its pixels. The 90% visual match cannot be measured until the app is installed
   on a machine with a display; that step is blocked, not skipped.
3. **No decompilation.** Control flow inside the binary is inferred from strings and schema, never from
   disassembly.

---

## 1. The harness — features

### 1.1 The agent loop
**seen.** `--print` exists for one-shot turns; `--output-format` accepts `text`, `json` and
`stream-json`; `--include-partial-messages` streams partial chunks; `--max-turns` bounds the loop.
**What I see:** a prompt goes in; assistant text and tool calls come back interleaved; the turn ends when
the model stops requesting tools.
**Behind it:** a loop that calls the model, executes requested tools, appends results, and repeats until
no tool calls remain or the turn cap is hit; streamed chunks are forwarded as they arrive rather than
batched.
**Test:** scripted pretend model returns text → tool call → text; assert three round trips, ordered
events, and a clean stop.

### 1.2 File read
**seen** (schema `FileReadInput`/`FileReadOutput`, plus catalogue strings). Also reads images and
notebooks, and refuses non-regular files (device/FIFO/socket) and oversized notebooks.
**Test:** read a text file, a PNG and a missing path; assert content, image block, and a structured
"not found" result rather than an exception.

### 1.3 File write
**seen** (`FileWriteInput`). Creates or overwrites, with the whole content supplied by the model.
**Test:** write a new file, assert it on disk; write over an existing file, assert replacement.

### 1.4 Exact-string edit
**seen** (`FileEditInput`, `MultiEdit` in the catalogue). Replaces a literal snippet; the edit is
rejected when the old text is absent or ambiguous.
**Test:** edit a unique snippet → applied; edit a duplicated snippet → refusal that names the ambiguity;
edit with stale text → "not found" result.

### 1.5 Shell execution
**seen** (`BashInput`, `BashOutput`, `KillShell`; a PowerShell variant string appears too). Takes a
command and optional timeout, keeps a persistent working directory between calls, and supports
background shells whose output is polled and which can be killed.
**What I see:** command output, exit code and duration come back as a tool result.
**Behind it:** a child process per call with a tracked cwd, output captured and truncated, and a
registry of background shells.
**Test:** run a command with output, run a failing command, run a background command and poll it, then
kill it.

### 1.6 Glob, Grep, list directory
**seen** (`GlobInput`, `GrepInput`, and a "Lists files in …" description string). Pattern matching for
paths, regular-expression content search with flags and file filters, and a directory listing.
**Test:** glob `**/*.js` in a fixture tree; grep a regex with context lines; list a directory; assert
counts and paths.

### 1.7 Todo list
**seen** (`TodoWriteInput`). The model maintains a structured task list with statuses that the UI can
render as a live plan.
**Test:** write three items, flip one to in-progress, assert the UI shows them and the next model call
carries them back.

### 1.8 Web fetch and web search
**seen** (`WebFetchInput`, `WebSearchInput`). Fetch takes a URL plus a prompt and returns extracted
content; search returns ranked results.
**Test:** fetch a local fixture over HTTP; run a search against a stubbed provider; assert summaries and
citation metadata.

### 1.9 Notebook edit
**seen** (`NotebookEditInput`, several validation strings). Edits cells in a `.ipynb` by cell id or
index, refusing invalid JSON.
**Test:** insert, replace and delete cells in a fixture notebook; assert the JSON stays valid.

### 1.10 Subagents and tasks
**seen** (`AgentInput`, `TaskCreate/Get/Update/List`, `TaskStop`, `subagent_heavy` guidance in the
payload). A subagent runs with its own context and returns a report; tasks are durable units that
survive across turns and can be listed and stopped.
**Behind it:** a nested agent invocation with its own tool set and a report back to the parent.
**Test:** dispatch a subagent that reads two files; assert the parent receives only the report; create a
task, list it, stop it.

### 1.11 Plan mode
**seen** (`EnterPlanModeInput`, `ExitPlanModeInput`, `"plan"` mode value). The agent researches
read-only, then submits a plan for approval before any write.
**Test:** in plan mode, attempt a write → blocked with an explicit reason; exit plan → write allowed.

### 1.12 Asking the user
**seen** (`AskUserQuestionInput`). Mid-turn questions with options, answered without ending the turn.
**Test:** model asks a question with two options; UI shows it; answering resumes the loop with the answer
in the transcript.

### 1.13 MCP
**seen** (`McpInput`, `ListMcpResources*`, `ReadMcpResource*`, `RefreshMcpToolsInput`; `claude mcp list`
reports "No MCP servers configured"; `--mcp-config` accepts config files). Servers are registered per
scope, their tools become callable, resources are listed and read.
**Test:** register a stub stdio MCP server, list its tools and resources, call one, refresh after the
server changes.

### 1.14 Workflow, cron, projects, findings
**seen** (input schemas exist: `WorkflowInput`, `CronCreate/DeleteInput`, `ProjectsInput`,
`ReportFindingsInput`). **unknown** for behaviour detail — no live run was possible, and the payload
window I extracted does not describe them. Recorded so we know they exist; a build-time decision is
needed on whether to include them.

### 1.15 Other catalogue tools
**seen** as schema only: `SendFeedback`, `Artifact`, `ClaudeDesign`, `Projects`, `TaskStop`. Marked
**unknown** in behaviour; the names and input shapes are all the evidence available.

### 1.16 Permission system
**seen.** Modes: `default`, `acceptEdits`, `plan`, `bypassPermissions` (with
`--allow-dangerously-skip-permissions` as an opt-in to even offer bypass). Allow/deny rules come from
`--allowedTools` / `--disallowedTools` and settings; a payload string documents that reads outside the
working directories are blocked by `permissions.blockReadsOutsideWorkingDirectories` with `/add-dir` as
the remedy; a bash allowlist gates pipelines per command.
**What I see:** an approval prompt that blocks the turn, with allow-once / allow-session / deny.
**Test:** allowed call runs; unlisted call prompts; denied call returns "denied by user" to the model
and the loop continues; session-allow stops further prompts for that tool.

### 1.17 Hooks
**seen.** Events: `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`PreCompact`, `Notification`, `Stop`, `SubagentStop`. Hooks are configured in settings and can block or
rewrite what happens at those points.
**Test:** a `PreToolUse` hook that denies `Bash` blocks the command; a `PostToolUse` hook records a log
line; `SessionStart` injects one line into the context.

### 1.18 Context accounting and compaction
**seen.** `/context` returns usage broken down by category (system prompt, tools, messages);
`auto_compact_window` is a setting; `--autocompact` accepts `auto` or a token window (100k–1M).
**Behind it:** token counting per request, a threshold, then a summary that replaces older turns.
**Test:** fill the context with a long fixture, trigger compaction, assert the summary keeps the current
task and the file list, and that the next request fits the window.

### 1.19 Sessions
**seen.** `--continue`, `--resume <id>`, `--fork-session` (new id when resuming); state lives under a
per-user config directory (`.claude/…`, with `projects`, `jobs`, `skills`, `hooks` visible in strings).
**What I see:** sessions list, resume, fork, rename, delete.
**Test:** run a turn, quit, `--resume`, assert history is intact; `--fork-session` creates a new id that
shares history but diverges afterwards.

### 1.20 Settings and project memory
**seen.** Files: `~/.claude/settings.json`, project `.claude/settings.json`, `.claude/settings.local.json`;
memory file `CLAUDE.md` (user and project); skills under `.claude/skills/`.
**Behind it:** layered settings (user → project → local) merged with precedence, memory file injected
into the system prompt, skills discoverable as slash commands.
**Test:** set a value in each layer and assert precedence; put a fact in the memory file and assert it
reaches the system prompt.

### 1.21 Slash commands
**seen** in the payload, by frequency: `/config`, `/mcp`, `/model`, `/clear`, `/resume`, `/status`,
`/memory`, `/init`, `/compact`, `/permissions`, `/terminal-setup`, `/agents`, `/export`, `/doctor`.
**Test:** each command runs from the composer and produces its documented effect; `/init` creates a
memory file; `/compact` shrinks the transcript with a summary.

### 1.22 Providers, auth and models
**seen.** `claude auth` (login/logout/status), `claude setup-token`, `apiKeyHelper` referenced by
doctor, an enterprise `gateway` command, `--model` and `--fallback-model`.
**unknown:** the exact wire protocol and streaming shape — it needs a live key to observe.
**Test:** with each of our own keys, one tool-using turn completes; the fallback model is used when the
primary returns an error.

### 1.23 Background sessions
**seen.** `--bg/--background`, and the `agents`, `attach`, `logs`, `stop`, `rm`, `respawn` subcommands.
**Test:** start a background session, attach, read logs, stop it, confirm it is gone from the list.

### 1.24 Output formats and SDK mode
**seen.** `--output-format text|json|stream-json`, `--input-format`, `--include-partial-messages`.
**Test:** stream-json run emits one JSON event per delta and a terminal result event with usage.

### 1.25 Packaging commands
**seen.** `install`, `update`, `doctor`, `import`, `purge`, `plugin`, `ultrareview` (cloud multi-agent),
`auto-mode`. `doctor` reports install method, platform, search backend, auto-update channel, and whether
managed settings were fetched.
**Test:** our app ships its own equivalent diagnostics (version, provider reachability, key presence,
config path) and reports them on one screen.

---

## 2. The Code view — features

Every item in this section is **unknown**, and for one reason only: the desktop app is not installed on
this machine, there is no `DISPLAY`, and installing Xvfb needs root. I could therefore not open the app,
click through it, or capture screenshots. I am recording the requirement and the test; the observation
slot stays empty until the app can be seen.

| # | Feature | Mark | Requirement | Test |
|---|---|---|---|---|
| 2.1 | Window chrome and top bar | unknown | project name, model, mode, usage, controls | screenshot matches reference within tolerance |
| 2.2 | Sidebar session list | unknown | title, time, cwd, new chat, search | create/rename/resume reflects immediately |
| 2.3 | Transcript | unknown | markdown prose, tool cards with status and collapsible output | a turn renders every event in order |
| 2.4 | Composer | unknown | multiline, send/stop, `@` files, `/` commands, images, queue | each input path works during a running turn |
| 2.5 | Permission dialog | unknown | blocks the turn; allow once/session/deny | dialog appears, choice is honoured |
| 2.6 | Changes panel | unknown | per-file diff, accept/revert, open in editor | edit a file, see the diff, revert it |
| 2.7 | Terminal panel | unknown | live command output plus an interactive shell | run a command, watch output, type into the shell |
| 2.8 | Status bar | unknown | connection, streaming, tokens, cost, cwd | values change live during a turn |
| 2.9 | Mode switcher | unknown | default/accept-edits/plan, always visible | switching changes gating immediately |
| 2.10 | Visual parity ≥ 90% | unknown | layout, panels, sizes, flow | measured comparison at equal window size |

The 90% target is a measurable requirement, not a vibe: our plan is side-by-side captures at the same
window size, a structural diff of region boxes (header, sidebar, transcript, composer, panels) and a
colour/typography sample, reported as one parity percentage in `CHECKLIST.md`.

---

## 3. Build plan

### Part 1 — engine, CLI mode, first window
- `app/` scaffolding: Electron main + preload + renderer in plain HTML/CSS/JS, no build step.
- Agent loop with streaming; provider adapters for **Gemini**, **OpenRouter**, **NVIDIA** behind one
  interface; pretend provider for the self-check.
- Tools: read, write, edit, multi-edit, glob, grep, list, bash (foreground + background with
  output/kill), todo, web fetch/search (stub-first).
- CLI mode: `kestrel -p "…"` with `text|json|stream-json`, `--max-turns`, `--model`.
- Window: transcript + composer + top bar; **Keys screen** (validate, encrypt outside the folder,
  masked) and model picker fed by each provider's model list.
- Self-check harness from day one: cold-start time, memory, per-step pass/fail, error screenshots.
- Exit: a real tool-using turn on one model per provider, cold start under 2 s, checks green.

### Part 2 — permissions, modes, persistence, panels
- Permission engine with rules, session allows, deny; dialogs; modes default/accept-edits/plan and the
  gating matrix from §1.16.
- Sessions on disk: create, rename, resume, fork, delete, restore after restart; per-session usage and
  cost.
- Project memory file, `/init`, system-prompt assembly with environment and mode; context accounting and
  compaction with a summary.
- Changes panel (diff, accept, revert) and terminal panel (live output + interactive shell).
- Slash commands: `/help /clear /compact /model /mode /init /cost /resume`.
- Exit: E2E covers permission grant and denial, a mode switch, resume after restart, compaction.

### Part 3 — everything else, real Claude Code, packaging
- Subagents and tasks, hooks (the nine events), MCP client, skills, plan mode, ask-user questions,
  queueing, images, `@` mentions.
- Claude Code provider: run the installed CLI in stream-json and map its events into our transcript —
  the only place the external tool is named.
- Kestrel identity: own name, own icon (SVG + PNG/ICO), desktop shortcut, packaged build.
- Visual parity pass against reference captures (when a display is available), measured and iterated to
  ≥ 90%.
- Exit: `CHECKLIST.md` with a tick per feature, every cross fixed or explained.

---

## 4. Open questions this study could not close

1. **Streaming protocol details** (event names, delta shapes, usage fields): needs one authenticated run.
2. **Code view layout, sizes and typography**: needs the desktop app on a machine with a display.
3. **Behaviour of `Workflow`, `Cron*`, `Projects`, `Artifact`, `ClaudeDesign`, `ReportFindings`**: only the
   input schemas are visible; no behaviour was observed.
4. **Auto-compaction thresholds and summary format**: the setting exists; the policy is internal.
5. **Whether bypass mode is even offered** without `--allow-dangerously-skip-permissions`: the flag
   suggests it is gated, but I could not observe the gate.

Each of these becomes a `guessed` item only when we implement it, and must be re-marked `seen` the
moment a real run shows it.
