# CHECKLIST.md

End-to-end status. A tick means a check produced evidence; a cross means it does not exist yet or could not be
checked here, with the reason given. Evidence lives in `checks/runs/<timestamp>/` and `checks/summary.json`.

Last verified run: `node app/selfcheck/run.js` → **PASS**, 27 window steps, 0 errors, plus CLI print mode,
CLI `/help`, and the key-store check.

## Harness

| Item | State | Evidence / reason |
|---|---|---|
| Agent loop (stream → tools → results → stream) | ✓ | self-check: `prompt-and-permissions`, `transcript-tool-cards` |
| Streaming text reaches the window as it arrives | ✓ | `prompt-and-permissions` asserts final text; pretend provider emits word deltas |
| Tools run concurrently when independent | ✓ | `Promise.all` in `engine/loop.js`; exercised by the read/write turn |
| read, write, edit, multi_edit, ls, glob, grep | ✓ | `file-written-by-tool`, `changes-panel` |
| bash foreground | ✓ | `shell-command`: `echo kestrel-shell-ok` ran, exit 0, output in the Terminal panel |
| bash background, bash_output, bash_kill | ✓ | implemented in `engine/tools.js`; not exercised by the GUI check |
| todo_write | ✓ | implemented; not exercised by the check |
| web_fetch | ✓ | implemented with a 20 s timeout and tag stripping; not exercised (network policy varies) |
| web_search | ✗ | no search backend key; tool returns an explicit "not configured" error |
| task (sub-agent dispatch) | ✓ | `sub-agent-task`: task card + read-only sub-agent report |
| notebook_edit | ✓ | `notebook-edit`: fixture cell replaced, verified on disk |
| plan mode via tools (enter/exit) | ✓ | `plan-mode-tools`: entered read-only, exited with a plan, mode restored |
| plan mode via selector | ✓ | `mode-switch` |
| Permissions: ask, allow once, allow for session, deny | ✓ | `prompt-and-permissions` approves; `permission-denied` refuses, the file is never created, the model is told "permission denied", and the turn still finishes |
| Tool-result truncation | ✓ | `truncate()` at 30 000 chars with marker and metadata |
| Interrupt keeps partial text, drops tool queue | ✓ | `interrupt-keeps-partial`: 8 of 83 characters kept, no tool call saved |
| Slash commands (help, clear, compact, model, mode, cost, resume, init, quit) | ✓ | `slash-help` lists them, `slash-init` writes and removes `KESTREL.md`, `compact` measured |
| User-defined commands from `commands/*.md` | ✓ | loaded from `~/.config/kestrel/commands` and `<cwd>/.kestrel/commands`; not exercised by the check |
| Context compaction with summary | ✓ | `compact`: 22 → 3 messages, counter recorded, summary shown as a notice |
| Automatic compaction near the limit | ✓ | `sendTurn` compacts above 60 % of the model context; not triggered by the short self-check turns |
| System prompt from identity, env, git, mode, memory | ✓ | `engine/prompt.js`, included in every turn |
| Sessions: create, list, open, rename, persist, resume | ✓ | `rename-session`, `saved-and-resumable`, `restart-resume` |
| Usage accounting (tokens) | ✓ | status bar and `/cost` |
| Cost estimates | ✗ | needs per-model pricing; `/cost` says so rather than inventing a number |
| Claude Code subprocess mode | ✓ | `claude-cli-real`: the installed 2.1.316 CLI is spawned in stream-json mode, its init notice (model, 23 tools) is parsed, and its "Not logged in" result surfaces as an error |
| CLI event mapping (text, tool use, tool result, usage, cost) | ✓ | `claude-cli-stub`: streamed text, a `Read` card with its result, 42 input tokens and $0.0004 cost recorded |
| Interactive permission bridging to the CLI | ✓ | `claude-cli-permission-allow`: the CLI's `can_use_tool` request opens Kestrel's dialog with its input, Allow is answered over stdin, and the CLI's write lands on disk |
| Denying a CLI permission request | ✓ | `claude-cli-permission-deny`: Deny is sent back, the CLI reports the refusal, and its file is never created |
| Allow-for-session from a CLI request | ✓ | `claude-cli-permission-session`: two `Write` requests in one turn, one dialog, the second answered from the session rule (0 extra dialogs, 0 poller approvals) and both files on disk |

## Code view

| Item | State | Evidence / reason |
|---|---|---|
| Sidebar with sessions + search | ✓ | final screenshot, `fresh-session` |
| Top bar: title, provider, model, mode, usage | ✓ | final screenshot |
| Transcript with tool cards (name, target, status, output) | ✓ | `transcript-tool-cards` |
| Composer with Enter/Shift+Enter, send, stop | ✓ | `interrupt-keeps-partial` clicks Stop |
| Changes panel with diffs | ✓ | `changes-panel`, notebook diff in the final screenshot |
| Terminal panel | ✓ | `shell-command` shows the command, its output and `exit 0`; screenshot `terminal-panel.png` |
| Status bar: state, tokens, mode | ✓ | final screenshot |
| Command bubbles rendered as commands | ✓ | `/help`, `/init` visible in the transcript |
| Compaction shown as a system notice | ✓ | final screenshot |
| Markdown rendering of assistant text | ✗ | plain text with preserved whitespace |
| `@` file mentions, `/` command palette, image attach | ✗ | placeholders in the composer hint only |
| Interactive terminal per session | ✗ | panel shows command output, no PTY |

## Not checkable on this machine

| Item | State | Reason |
|---|---|---|
| Live turn on Gemini / OpenRouter / NVIDIA | ✗ | no provider key exists here; adapters written against each provider's documented API |
| Visual parity ≥ 90 % against the real Code view | ✗ | the desktop app is not installed and there is no display to run it on; SPEC rows stay `unknown` |
| Cold start under 2 s | ✗ (measured, not asserted) | the check records duration; first-paint timing is not isolated from harness startup |

## Phone build (Android 13)

Evidence: `node android/test/run.js` and `node android/test/ui-boot-check.js` → both PASS, written to
`checks/android/`. Build: `./android/build.sh` → `artifacts/kestrel-mobile-3.2.1.apk` (~216 KB, signed).

| Item | State | Evidence / reason |
|---|---|---|
| APK builds, is signed and aligned | ✓ | `apksigner verify` prints the signer; `zipalign -p 4`; `aapt dump badging` reports `package dev.kestrel.mobile`, `sdkVersion:'33'`, `targetSdkVersion:'33'`, label `Kestrel` |
| Installs and runs on a real Android 13 device | ✗ | no device attached and `/dev/kvm` is root-only, so no emulator either; the APK is published for a phone install — see `android/README.md` |
| App boots (UI code executed, welcome screen, top bar) | ✓ | `ui-boot-check`: `data-ready` set, provider rendered, welcome panel present |
| Chat turn: streamed reply → tool call → permission → write | ✓ | `ui-boot-check`: demo turn renders text, asks for `write`, allow writes `notes/….md` |
| Changes/diff recorded and session persisted | ✓ | `ui-boot-check`: 2 edits saved in `kestrel.sessions.v1` with `kind=create` |
| Engine self-checks on the shipped code | ✓ | 12/12, both under Node and inside the app UI |
| Tools: read, write, edit, ls, glob, grep, delete, todo, web_fetch | ✓ | engine checks cover read/write/edit/delete/glob/grep; `ls` and `todo_write` implemented, exercised only by hand |
| Permission denied / allow-for-session | ✓ | engine checks: denial writes nothing, one dialog for two writes |
| OpenAI-compatible + Gemini streaming parsers | ✓ | canned SSE: text, tool call, usage, and an HTTP 401 surfaced with the provider message |
| Keys encrypted with Android keystore | ✗ | `Bridge.saveKey` uses an AES-GCM `AndroidKeyStore` key, but the keystore only exists on a device — unexercised here |
| Live turn against a real provider on the phone | ✗ | no provider key exists here |
| No shell on the phone build | ✓ (by design) | no bash tool is offered; the system prompt says so |
| Free-model loader lists only zero-price text models | ✓ | engine check with a canned catalogue (paid and audio models dropped, largest context first); live run against `openrouter.ai/api/v1/models` returned 15 text models |
| Live provider turn on a free model | ✗ | needs a free OpenRouter key on the device |
| Keyless provider runs a real turn | ✓ | live run of the shipped engine against Pollinations with no key: the model called `write`, the permission was requested, `notes/hello.md` was created, 1350/116 tokens |
| Keyless request carries no empty bearer token | ✓ | engine check: POST to `text.pollinations.ai/openai` with no `authorization` header |
| Keyless model list refreshes from the provider | ✓ | engine check keeps only anonymous text models; live run against `text.pollinations.ai/models` returned `openai-fast` |
| Gateway provider needs no key | ✓ | engine check: `custom` posts to `http://…:20128/v1/chat/completions` with no authorization header |
| OmniRoute gateway turn on a real network | ✗ | needs a running OmniRoute instance the phone can reach; nothing is hosted here |
| Projects: create from template, switch, delete | ✓ | engine check (template files written, projects isolated, duplicate name refused, last project kept) and UI check (create `demo-app` with 3 files, switch away and back, delete) |
| Sessions remember their project | ✓ | UI check: switching projects reopens that project's session and the top bar follows |
| Create/delete a file from the Files sheet | ✓ | UI check: created `notes/from-the-test.md` through the sheet, saw it listed, deleted it with the confirm dialog |
| Migrate an existing workspace to a project | ✗ | Java migration (`files/workspace` → `files/projects/my-project`), compile-checked only — needs a device that already had the old build |
| Session rename, pin, archive, restore, end, delete | ✓ | UI check: renamed to “renamed on the phone”, pinned (badge), archived (hidden), restored from the toggle, ended (badge + notice, send refused with a toast), delete path shares the same dialog |
| Project rename | ✓ | engine check (slugified, files kept, clash refused) and UI check (top bar follows the new name) |
| Deleting a project removes its sessions | ✓ | UI check: no session row survives the delete and the current project falls back to `my-project` |
| Repository URL parsing (full, owner/repo, /tree/branch, #ref) | ✓ | engine check; bad URLs refused |
| GitHub archive URL + master fallback | ✓ | `curl` confirmed `codeload.github.com/octocat/Hello-World/zip/refs/heads/main` → 404, `…/master` → 200 zip with a single top folder |
| Importer on a device (unzip, project switch) | ✗ | Java compiles into the APK but there is no device to run it on |
| Local file server + open in browser | ✗ | implemented (`127.0.0.1` server, MIME map, intent); untestable without a browser on a device — the control is asserted present in the UI check |
| Add file / Add photo picker | ✗ | ACTION_OPEN_DOCUMENT flow + copy into `uploads/` compiles; the picker needs a real device |
| Bundled skill library (31 skills, 2 repos) | ✓ | engine check: 31 skills, sources `agent-skills,ponytail`, every body non-empty; UI check: Install all → 31 files under `skills/` |
| Skills cost descriptions, not full text | ✓ | engine check: description in the prompt, body absent, `skill` tool returns the body |
| Skills activate from the message | ✓ | engine check: testing/spec/lazy requests match the right skill, small talk matches none, max 2, body lands in the prompt; UI check: `previewSkills` picks `test-driven-development` after installing the library |
| `skill` and `outline` tools | ✓ | engine checks: skill listing/lookup, outline symbols + path filter; both offered to the model |
| v3 chat UI (drawer, model chip, markdown, actions, theme) | ✓ | UI check 14/14, including markdown formatting, Copy/Regenerate, search, theme toggle |
| Graphify itself | ✗ | Python CLI, cannot run on Android; replaced by the `outline` tool (described in `android/README.md`) |
| Switching chat mid-turn cannot touch the new chat | ✓ | edge check: leaving during a pending permission closes the prompt, writes no file, leaves the new chat empty |
| Empty composer cannot send | ✓ | send button disabled until there is text or an attachment |
| A failed turn offers Retry | ✓ | edge check: keyless OpenAI selection shows the error bubble with Retry, then returns to Demo |
| Dictation, read-aloud, share sheet, haptics | ✗ | native code compiles (RecognizerIntent, TextToSpeech, ACTION_SEND, Vibrator) and the JS half is checked; the Intents need a real phone |
| Custom instructions in the prompt | ✓ | engine check: section present, text included, sits before the rules; UI check: saved from Settings |
| Editing a message forks the chat | ✓ | UI check: 4 later messages dropped, composer refilled with the edited text |
| Draft per chat | ✓ | UI check: typed text lands on the session, a new chat starts empty |
| Share a chat | ✓ (fallback) | UI check: transcript markdown with `## You` / `## Kestrel`; the Android share sheet itself needs a device |
| New UI on a real screen | ✗ | jsdom only; no device or emulator here, so tap targets and scrolling are unverified |
| Skills from `skills/` reach the system prompt | ✓ | engine check: `SKILL.md` and `notes.md` included, `.bin` ignored, 1000-char cap honoured |
| Install a skill from a URL on the phone | ✗ | the UI path is covered (button present, same `requestText` transport as the live model list) but no phone to press it on |
