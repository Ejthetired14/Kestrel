# AGENTS.md

Working rules for every session on this project. These override convenience and are not optional.

## How to work

1. **Do everything yourself. Never ask the user anything.** Make the reasonable call, note the
   assumption, and keep going. The only exception is a password prompt: stop and say so.
2. **Announce each step in one line before doing it.**
3. **Never say something is saved, fixed or working unless a check shows it.** Quote the check. If a
   check could not run (no display, no key, no engine), say exactly that and mark the item a cross, not
   a tick.
4. **Write our own code.** Never copy code, prompts, tool descriptions or built-in instructions from
   Claude Code or the Claude app. Study behaviour, then implement it ourselves in our own words and
   our own structure. Installed Claude artefacts are read-only study material.

## Stack

- **Electron with plain HTML, CSS and JavaScript.** No React, no Vue, no bundler, no build step, no
  packages that need compiling (no native addons, no node-gyp).
- The renderer loads plain ES modules; the main process owns windows, filesystem, providers and keys.
- One shared `package.json` at `app/`. Dependencies must be prebuilt-only and few.

## Speed rules

- Tools that do not depend on each other run **at the same time** (`Promise.all`), never in sequence.
- **Nothing loads until it is needed**: lazy routes, lazy diffs, lazy transcripts, model lists fetched
  once and cached.
- Streaming text is appended to a single DOM node; the transcript is never fully re-rendered per token.
- Target: window interactive in **under 2 seconds**; reply words visible as they arrive.

## Running things

- **Never run anything that keeps running in the foreground.** Start the app and any server in the
  background with output redirected to a log inside `checks/`, record the PID, and poll for readiness.
- Stop only PIDs we started. Never kill by name pattern.

## Keys

- Keys are entered on the app's Keys screen, validated with a real request, then **encrypted and saved
  on this computer, outside this folder** (user config dir, e.g. `~/.config/kestrel/keys.bin`).
- Encryption key comes from the OS keyring when available, otherwise a machine-derived key file with
  0600 permissions.
- Keys are **never shown in full** after entry (masked), never logged, never committed, never printed in
  chat. Copy into the renderer only as masked previews.

## Self-check (run after every change)

- `app/selfcheck/run.js` launches the real app with a **pretend model** that needs no key, drives it end
  to end: new session → prompt → streaming reply → tool call → permission prompt → allow → file edit →
  diff panel → terminal panel → mode switch → rename → restart and resume.
- It writes into `checks/`: a screenshot of **every error**, the start time (cold start measurement),
  memory use, and a pass/fail line per step. It always closes the app afterwards.
- Run it after every change. **Fix every error it reports before moving on.**

## Versions

- Commit a version each time a feature works, with a message naming the feature that now works and the
  check that proves it. Never commit `node_modules`, builds, `study/`, `checks/`, or keys.

## Layout

- `app/` — the application (main process, preload, renderer, self-check).
- `SPEC.md` — the studied feature list with `seen` / `guessed` / `unknown` marks and the build plan.
- `CHECKLIST.md` — end-to-end tick/cross list; every cross must be fixed or explicitly explained.
- `study/` — REA output, CLI captures, reference screenshots. Evidence only, never shipped, not tracked.
- `checks/` — self-check screenshots, timings, memory. Evidence only, not tracked.
