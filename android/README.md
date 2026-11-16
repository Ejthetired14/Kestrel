# Kestrel for Android

The phone build of Kestrel. Same idea as the desktop app — a coding agent that streams
replies, calls tools, asks permission and shows the diff — sized for a phone screen and
installed as an APK on Android 13 (API 33).

There is no Gradle, no AndroidX, no npm package and no build daemon. The APK is assembled
with the Android build-tools directly (`aapt2`, `javac`, `d8`, `zipalign`, `apksigner`), so
the build is a few seconds and depends on nothing but a JDK and the SDK.

## Layout

| Path | What it is |
|---|---|
| `app/assets/www/` | The app itself: plain HTML, CSS and three classic scripts |
| `app/assets/www/kestrel-engine.js` | Engine: workspace fs, tools, providers, agent loop, sessions, keys |
| `app/assets/www/kestrel-selftest.js` | 12 self-checks that run on the device and on a laptop |
| `app/assets/www/app.js` | Phone UI: transcript, tool cards, sheets, permission dialog |
| `app/src/dev/kestrel/mobile/` | The native shell: WebView activity and a small bridge |
| `app/res/` | Manifest resources: theme, strings, adaptive launcher icon |
| `build.sh` | Builds and signs `../artifacts/kestrel-mobile-3.2.4.apk` |
| `test/run.js` | Runs the shipped engine + self-checks under Node |
| `test/ui-boot-check.js` | Boots the shipped UI in jsdom and drives one demo turn |
| `site/` | The download page deployed for phone installs |

## Build

Needs JDK 17 and an Android SDK with `platforms;android-33` and `build-tools;34.0.0`
(in `$ANDROID_SDK_HOME` or `~/toolchain/sdk`).

```sh
./android/build.sh
# artifacts/kestrel-mobile-3.2.4.apk  (signed, minSdk 33, targetSdk 33)
```

The signing key is generated once at `~/.kestrel-android/sideload.keystore` — outside the
project, never committed.

## Check

```sh
node android/test/run.js                     # engine self-checks, no device needed
NODE_PATH=/tmp/domtest/node_modules \
  node android/test/ui-boot-check.js         # boots the shipped UI (npm i jsdom once)
```

Both write their evidence to `checks/android/`. Inside the app the same self-check list is
under **Settings → Run self-check**, so the phone proves itself on the device.

## Install on a phone

Open the hosted page and tap the download, or copy the APK over and tap it:

https://site-acdde076c8474660a32461fbe49d7b3f.freebuff.page

Allow installs from the file manager or Chrome when Android asks, then install.
The build is self-signed, so Play Protect may ask once more — that is expected for sideloads.

## Projects

A project is a folder under app-private `files/projects/<id>`. The bridge keeps a
current root and resolves every read and write against it, so switching is cheap and the
agent can never see another project.

- **Tap the title bar** → Projects: switch, create, delete.
- **New project** writes a template: `blank`, `notes`, `static web page` (index.html,
  styles.css, README.md) or `node script` (index.js, package.json, README.md).
- **Sessions belong to a project**: the session list shows the project, and switching puts
  that project back in place before any file is read.
- The last project cannot be deleted. A build older than 2.0.0 kept its files in
  `files/workspace`; on first start that folder becomes the project `my-project`, so
  nothing already written is lost.
- Files sheet: create a file, open one, delete one.

There is no cloud sandbox, preview server, deployment or git on the phone build: no shell
runs, so nothing can be built, served or deployed from the device.

## Three checks

No device is available here, so the app is verified three ways. Run all three before shipping:

```bash
node android/test/run.js                                      # 24 engine steps
NODE_PATH=/tmp/domtest/node_modules node android/test/ui-boot-check.js   # 16 UI steps (happy path)
NODE_PATH=/tmp/domtest/node_modules node android/test/edge-check.js       # 12 UI steps (awkward paths)
```

The edge pass exists because the happy path hid a real bug: a turn's `finally` block and its
permission callback acted on whichever chat was current, so switching chats mid-turn could write
the old turn's token usage — or approve a file write — into the new one. Turns now carry a sequence
number; leaving a chat bumps it, aborts the turn, closes its prompt, and the abandoned turn is
barred from saving, reporting usage or approving tools.

## Skills: the bundled library

`app/assets/www/kestrel-skills.js` ships 31 skills from two MIT repositories:

- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) — `ponytail`, `ponytail-review`,
  `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help` (Copyright © 2026 DietrichGebert).
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) — 25 lifecycle skills from
  `spec-driven-development` to `shipping-and-launch` (Copyright © 2025 Addy Osmani).

Content is unmodified, MIT-licensed text. Regenerate the bundle with
`node android/tools/collect-skills.js` after cloning those repositories under `study/` (gitignored).

**How they are used.** The system prompt carries only each installed skill's name and one-line
description (capped at 2400 characters). The full text arrives through the `skill` tool, so
installing all 31 costs a few hundred tokens instead of ~90,000. Install them from **⋯ → Skills**.

**Automatic activation.** Every message is scored against the installed skills before the turn
starts (`matchSkills` in the engine). A word from a skill's *name* scores 5 (7 for the head word,
since names lead with their subject: `test-driven-…`, `spec-driven-…`); description words score 1
each, capped at 3. A score of 3 activates the skill, at most two per message, and only their bodies
— up to 8000 characters — join that turn's system prompt. The chat shows a small `◆ name applied for
this message` chip, and the match is per message, not sticky for the session. Small talk scores zero:
`hello there, how are you today` activates nothing.

## Outline: the graphify idea, implemented small

[Graphify](https://github.com/Graphify-Labs/graphify) (Apache-2.0) maps a project into a graph so an
agent queries structure instead of grepping. We cannot run its Python CLI on Android, so the phone
app implements the same idea with regexes as a **`outline` tool**: files with their functions,
classes, arrow-function consts, CSS selectors and markdown headings, each with a line number, capped
at 8000 characters. The model calls it first on an unfamiliar project, then reads only what it needs.

## What makes it an AI app, not a chat box

| Feature | How it works here |
|---|---|
| Dictation | The mic in the composer opens Android's own `ACTION_RECOGNIZE_SPEECH`; the words land back through `__kestrelDictation`. No recording permission is needed because the recogniser app does the listening. |
| Spoken replies | Optional read-aloud (`TextToSpeech`) that stops as soon as you send again. Markdown fences become "code block" so it does not read punctuation. |
| Custom instructions | "About you" in Settings travels with every request as its own system-prompt section. |
| Editing a message | Every user bubble has Copy and **Edit**; editing drops the later messages and refills the composer, which is the regenerate/branch loop without a message tree. |
| Share a chat | Markdown transcript → Android share sheet; if no app can take it, the text is shown to copy by hand. |
| Drafts | The composer keeps unsent text per chat, so switching chats and coming back does not lose it. |
| Haptics | A short tick when a message is sent. |

## UI, v3

Chat-first shell modelled on what the mainstream AI apps converged on: a drawer of chats with search
and date groups, a model chip at the top, an empty state with suggestion cards, user bubbles against
full-width assistant replies, markdown with copy-ready code blocks, Copy/Regenerate per reply, a
thinking indicator, jump-to-latest, attach chips, and a dark/light theme.

## GitHub: commit and push from the phone

Settings → **GitHub** connects the app to a real repository. Paste a personal access
token (classic with `repo`, or fine-grained with *Contents: read and write*), press
**Save token** — it goes into the same keystore-backed store as model keys and is only
ever shown masked — then:

- **Check connection** calls `GET /user` and reports the login it belongs to.
- **Create repository** makes a private repo with a README (`POST /user/repos`), then
  fills the repository and branch fields from the answer.
- **Commit this project** pushes the current project as **one commit** using the Git
  Data API: read `git/ref/heads/<branch>` → read its commit → build a tree with every
  text file → create the commit → move the branch with `PATCH git/refs/heads/<branch>`.
  Remote files the project does not have are left in place (`base_tree`), nothing is
  force-pushed, and the result line links to the commit.

Limits, stated rather than hidden: up to 150 files and 400 KB per file per push; binary
extensions (images, archives, audio, fonts, APKs) are skipped and counted in the result;
the branch must already exist, so a brand-new repo needs **Create repository** first.
The token is sent as `Authorization: Bearer …` with GitHub's API version header and a
`Kestrel-Android` user agent; a 401/403 shows GitHub's own message in the panel.

## Import a GitHub repository

Android has no git and no shell, so Kestrel imports a repository the only way an APK can:
Projects → **Import from GitHub** takes a URL (`https://github.com/owner/repo`,
`owner/repo`, `…/tree/branch`, `owner/repo#ref`), downloads
`codeload.github.com/<owner>/<repo>/zip/refs/heads/<branch>` (default `main`, retried as
`master`), and unpacks it into a new project with the archive's single top folder stripped.

Guards: zip-slip is impossible (entries containing `..` are dropped and every path is checked
against the project root), `.git/` is skipped, archives are capped at 40 MB, single files at
5 MB and the unpacked tree at 60 MB / 3000 files. What you do **not** get: history, branches,
submodules, or `npm install` — there is no package manager on the phone.

## Open a file in the browser, and add files or photos

- **Open in browser** (file view): the app starts a tiny HTTP server bound to **127.0.0.1**
only, serving the current project, and opens `http://127.0.0.1:<port>/<path>` with an
`ACTION_VIEW` intent. Using a real URL instead of a `file://` hand-off means a page's CSS,
JS and images resolve. The server stops with the activity.
- **Add file / Add photo** (Files sheet): opens the system document picker (photos are
pre-filtered to images), copies each pick into `uploads/` of the current project with
collision-safe names, and refreshes the listing.

## Sessions

☰ lists sessions for every project; the ⋯ button on a row opens its actions:

- **Rename** — the title is just data, so this is instant.
- **Pin to top** — pinned sessions get their own group above the rest.
- **Archive** — hidden behind a "Show archived (n)" toggle; restoring re-lists it.
- **End session** — the transcript becomes read-only: sending is refused with a toast and a
  notice is appended, so a finished conversation cannot be continued by accident (a running
  turn is aborted).
- **Delete** — asks first, then removes it.

Deleting a **project** also deletes its sessions: a session must never point at a folder that
no longer exists. Renaming a project rewrites its sessions' `project` field.

## Free models

Two different things, and the app should not blur them:

1. **No key at all** — provider **Pollinations (no key)**, model `openai-fast` (GPT-OSS 20B,
anonymous tier). OpenAI-compatible SSE with tool calls, so the full agent loop works with
nothing to sign up for. Settings → **Load models (no key)** reads that service's own
catalogue and keeps only anonymous text models. It is rate limited and the prompt text does
leave the phone. This is the only keyless public endpoint that still answered when checked
(Hack Club's endpoint is gone; OpenCode Zen needs an account token).
2. **Free models behind a free account key** — Settings → **Load free models** asks
OpenRouter for its public catalogue (the list itself needs no key) and keeps only entries
that cost nothing **and** produce text, so music/image models never appear as chat choices.
Picking one switches the provider to OpenRouter; the chat turn then needs a free OpenRouter
API key. That list currently has 15 models, e.g. `inclusionai/ling-3.2-flash:free` (1M context).

Gemini and Groq also have free tiers and are built-in providers: add their key in Settings
and the static model list is ready to use. DeepSeek is built in too (`deepseek-chat`,
`deepseek-reasoner`); its API is paid but cheap, there is no keyless free tier.

### Every provider in mnfst/awesome-free-llm-apis

The built-in provider list also mirrors
[mnfst/awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis): Aion Labs,
Cohere, Z AI (GLM), Gonka Broker, ModelScope, NVIDIA NIM, SiliconFlow and Cloudflare
Workers AI ship with that list's model ids and their OpenAI-compatible base URLs. Three
more answer with **no key at all** — Kilo Code (`api.kilo.ai/api/gateway`, 9 free models),
LLM7.io (`api.llm7.io/v1`, anonymous `turbo` models) and OVHcloud AI Endpoints
(`oai.endpoints.kepler.ai.cloud.ovh.net/v1`, 9 open-weight models, 2 RPM per IP).
Workers AI is account-scoped: paste
`https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1` as the Base URL.
The self-check verifies every provider has an https base and models, so a broken entry
fails the build rather than the phone.

## Gateways (OmniRoute, OpenCode Zen, LM Studio)

Provider → **Custom / gateway (OpenAI-compatible)** takes a base URL and leaves the key
optional. That is the honest way to use a gateway like OmniRoute from a phone: the gateway
process holds the provider credentials, and Kestrel only needs to reach it.

- Self-hosted OmniRoute: `http://<laptop-or-pi>:20128/v1`, model `auto`. Its keyless pools
  (OpenCode Free etc.) are what make it feel like no keys at all — the key lives in the
  gateway, not in the app. The gateway must be running somewhere the phone can reach.
- Cleartext `http://` is allowed in the manifest for exactly this LAN case; public APIs
  should use `https://`.
- Kestrel's own free-model list is not a gateway: it removes the cost, not the account.

## Skills (installing agent instruction packs)

A skill is markdown under `skills/` in the workspace — either `skills/tone.md` or
`skills/<name>/SKILL.md`. Every turn, up to 12 skills and 6000 characters, is appended to
the system prompt under "Skills the user installed".

Settings → **Add skill from URL** fetches a markdown file (for example a `SKILL.md` from a
GitHub raw URL) and saves it into `skills/`, so instruction packs such as
`DietrichGebert/ponytail` or `addyosmani/agent-skills` can be installed from the phone.
Only the text is kept; none of their code is bundled into the APK.

Things that cannot be installed this way, for the record: `ChrisCompton/omniroute` is a
self-hosted Node gateway (its OpenAI-compatible endpoint works in Kestrel's **Custom
(base URL)** provider only if you host it somewhere the phone can reach), and
`Graphify-Labs/graphify` is a Python CLI that needs a computer.

## What is different from the desktop app

- **No shell.** There is no bash, no PTY and no package manager on a phone this app can
  reach. Tools are `read`, `write`, `edit`, `ls`, `glob`, `grep`, `delete_file`,
  `todo_write`, `web_fetch`.
- **Private workspace.** Files live in the app's own storage (`files/workspace`); nothing
  outside it is reachable and paths that climb out are rejected natively and in JS.
- **Keys.** Stored in app-private preferences, encrypted with an AES-GCM key held by the
  Android keystore. Shown masked only.
- **HTTP is native.** The WebView loads from `file://`, so provider calls go through the
  bridge (`HttpURLConnection`) which streams the body back into JS as chunks.
- **Demo mode** is the default provider: a scripted offline model that exercises the loop,
  the permission dialog, the file tools and the diff without a key.
- **Free-model loader and skills** are phone-only: a live zero-cost model list, and
  markdown instruction packs folded into the system prompt.
