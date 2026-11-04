# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

theory.md is a desktop-only Obsidian plugin. Humans write a "theoretical model" of a software system as notes in a git-backed vault. **Compile** sends the vault commits made since the last compile to the Claude Code CLI, which changes a separate project folder to match the model. The AI never writes to the model.

- `WORKFLOW.md` is the detailed spec: every workflow step by step, the invariants and the failure table. Read it before changing the compile pipeline, the marker, guards or overlays. If it disagrees with the code, the code wins. Update it when behaviour changes.
- `README.md` is the user-facing doc, with a feature status table. `theory.md` is the product pitch and philosophy.

## Commands

```bash
npm install
npm run build   # tsc type-check (noEmit, src and tests), then esbuild production bundle
npm run dev     # esbuild watch, inline sourcemaps (no type-check)
npm test        # Vitest, every test once
npm test -- test/branches.test.ts             # one test file
npm test -- test/branches.test.ts -t "reuses" # one test, by name
```

There is no linter. Before every commit run `npm run build` and `npm test`; both must pass. Never commit past a failing test.

## Tests

The rules are in the model's `obsidian-plugin/instructions.md` (TEST-1 to TEST-8). In short:

- Tests live in `test/*.test.ts`. Every change to branch, commit, compile or anchor logic comes with a test that would have failed before it.
- Tests that need git make real repositories with `tempFolder()` and `initRepo()` from `test/helpers.ts`. The folder is new under the system temp folder and deleted after each test. Never point a test at the vault, the project folder or a real repository.
- `test/setup.ts` puts fake `claude` and `gh` first on PATH (they always fail) and gives git a test config instead of the engineer's. Tests never reach Claude Code, GitHub or the network.
- ACP agent tests (`test/acp.test.ts`) run a small fake agent written into the test's temp folder and started with `process.execPath`, never a real agent.
- `obsidian` is replaced by the small stub in `test/obsidian.ts` (see `vitest.config.ts`). Add to it only what a tested module needs to load. Views, modals and the file explorer aren't tested automatically; check them by hand in Obsidian.
- To test logic that lives in a view or in `main.ts`, move it into a plain exported function first (like `withAllowedRules` or `entryFileSelector`).

The build writes a complete plugin folder to `dist/` (`main.js`, plus `manifest.json` and `styles.css` copied in). To try it, copy those files into `<vault>/.obsidian/plugins/theory-md/` and reload the plugin in Obsidian. `dist/data.json` is local plugin data (settings and reports) from a test install. Don't commit or rely on it.

## Naming

The product is **theory.md**. The plugin id and folder are `theory-md`, classes use `Theory…` (`TheoryPlugin`), and view types, CSS classes and temp folders use the `theory-` prefix (`theory-report`, `$TMPDIR/theory-model-*`). The plugin used to be called `mecho`. Older installs live in `plugins/mecho/`, and vaults set up back then have a `.gitignore` entry for `plugins/mecho/data.json`.

## Architecture

`src/main.ts` holds the plugin lifecycle: commands, views, event wiring and the in-memory compile lock (`compileRun`). It calls into one module per feature. The file-to-responsibility table is in WORKFLOW.md §3.

Things that need several files to understand:

- **Git is a subprocess, not a library.** Everything goes through `git()` in `src/vault.ts`. Subprocesses (git, claude and gh) run with `PATH: toolPath()` from `src/tool-path.ts`, because Obsidian launched from the Dock doesn't inherit the shell PATH. `onload` reads the login shell's PATH once (5 second limit) and adds `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin` and `~/.local/bin` after it; when the shell fails, they go after Obsidian's own PATH. Use the same env for any new subprocess.
- **The compile pipeline** (`src/compile.ts`) runs in this order: `theory/compiled` tag → `git log`/`git diff` of `from..HEAD` → `git archive HEAD` into a read-only temp snapshot → spawn `claude -p --output-format stream-json --json-schema …` with `cwd = projectFolder` and the prompt on stdin → parse the stream → run the guards → move the tag. `REPORT_SCHEMA` and `buildPrompt` define the contract with Claude. With the Agent setting on "ACP agent", `src/acp.ts` runs the engineer's ACP agent instead (JSON-RPC over stdio, the same prompt plus the schema, the answer from the last JSON block); it has no deny rules, so the snapshot and vault checks are what protect the model. The report view, overlay and note status all read the fields they produce.
- **State lives in only three places:** git (history, plus the `theory/compiled` tag as the last-compile marker), front matter (`realized: false`), and plugin data (settings plus the last 20 reports). Note compile state, pending counts and button states are worked out each time from these, never stored.
- **Problem anchors** (`src/anchor.ts`): Claude proposes `{path, heading?, quote?}`. `checkProblems` checks them against the snapshot before they're kept. `overlay.ts` (CodeMirror decorations plus banners) and `note-status.ts` use the checked anchors and the report's `suspectNotes`.
- **Pulls** (`src/pull.ts`) only ever fetch and fast-forward, and run git with `NO_PROMPT_ENV` so a credential prompt fails instead of hanging Obsidian. `Puller` decides when a pull runs (never during a compile, focus at most every 30 seconds) and is shared by the timer, focus, Pull now and the pull at the start of `compile()` in `main.ts`. `compileGate` turns that last pull into a reason not to compile, or the offline notice.
- **Dot folders** (`.obsidian/`, `.comments/`, any folder starting with `.`) are never theory: `DOT_FOLDERS` in `src/compile.ts` keeps them out of the snapshot, diffs and pending revisions, and `isInDotFolder` in `src/vault.ts` keeps them out of the changed files and the vault check. Comments (`src/comments.ts`) live in `.comments/` and commit themselves, one file per commit.
- **The author is git's.** `gitIdentity` reads `user.name`/`user.email` from the vault's own config, else the global one, and every commit passes them with `-c`. The settings never edit them; `fullName`/`email` in plugin data are only an older version's values, offered once for the vault's config.
- **`src/explorer.ts`** patches the file explorer's internal `getSortedFolderItems`, and adds the change dots to the rows of its private `fileItems`. That's private Obsidian API, so it must be undone on unload.

## Invariants not to break

These are in full in WORKFLOW.md §7. In short:

- The AI never writes to the vault. Keep the read-only snapshot, the `--disallowedTools` deny rules on both the vault and the snapshot, the snapshot hash check and the vault working-tree check.
- Only committed revisions are compiled (`git archive HEAD`, never the working tree).
- The marker moves once Claude has run, whether it succeeded or failed. It never moves on cancel or when the compile can't start.
- Reports live only in plugin data, never in the vault.
- Overlays are display only. Build them with `setText` or attributes, never HTML or Markdown, and never write to a note to show them.
