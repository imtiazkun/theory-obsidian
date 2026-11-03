# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

theory.md is a desktop-only Obsidian plugin. Humans write a "theoretical model" of a software system as notes in a git-backed vault. **Compile** sends the vault commits made since the last compile to the Claude Code CLI, which changes a separate project folder to match the model. The AI never writes to the model.

- `WORKFLOW.md` is the detailed spec: every workflow step by step, the invariants and the failure table. Read it before changing the compile pipeline, the marker, guards or overlays. If it disagrees with the code, the code wins. Update it when behaviour changes.
- `README.md` is the user-facing doc, with a feature status table. `theory.md` is the product pitch and philosophy.

## Commands

```bash
npm install
npm run build   # tsc type-check (noEmit), then esbuild production bundle
npm run dev     # esbuild watch, inline sourcemaps (no type-check)
npm test        # the Vitest suite, once
npx vitest run test/branches.test.ts          # one test file
npx vitest run -t "reuses the open compile"   # one test, by name
```

Before every commit, run `npm run build` and `npm test`; both must pass. Never commit past a failing test. Every change to branch, commit, compile or anchor logic comes with a test that would have failed before it. There is no linter.

## Tests

Tests live in `test/*.test.ts` and run with Vitest (`vitest.config.ts`).

- `obsidian` is replaced by `test/obsidian-stub.ts`. Views, modals and the file explorer aren't tested automatically; a person checks them in Obsidian. Keep testable logic out of the view files.
- Tests that need git make real repositories in a new temporary folder with `tempDir()`/`repo()` from `test/helpers.ts`, which deletes them afterwards. `test/setup.ts` points git at an empty config, so the engineer's own git config never applies. Tests never touch the vault, the project folder or real repositories.
- Tests never call Claude Code, GitHub or the network. Mock `src/github.ts` with `vi.mock`, or pass a fake `claude` script as the command.

The build writes a complete plugin folder to `dist/` (`main.js`, plus `manifest.json` and `styles.css` copied in). To try it, copy those files into `<vault>/.obsidian/plugins/theory-md/` and reload the plugin in Obsidian. `dist/data.json` is local plugin data (settings and reports) from a test install. Don't commit or rely on it.

## Naming

The product is **theory.md**. The plugin id and folder are `theory-md`, classes use `Theory…` (`TheoryPlugin`), and view types, CSS classes and temp folders use the `theory-` prefix (`theory-report`, `$TMPDIR/theory-model-*`). The plugin used to be called `mecho`. Older installs live in `plugins/mecho/`, and vaults set up back then have a `.gitignore` entry for `plugins/mecho/data.json`.

## Architecture

`src/main.ts` holds the plugin lifecycle: commands, views, event wiring and the in-memory compile lock (`compileRun`). It calls into one module per feature. The file-to-responsibility table is in WORKFLOW.md §3.

Things that need several files to understand:

- **Git is a subprocess, not a library.** Everything goes through `git()` in `src/vault.ts`. Subprocesses (git and claude) run with `PATH: TOOL_PATH`, because Obsidian launched from the Dock doesn't inherit the shell PATH. Use the same env for any new subprocess.
- **The compile pipeline** (`src/compile.ts`) runs in this order: `theory/compiled` tag → `git log`/`git diff` of `from..HEAD` → `git archive HEAD` into a read-only temp snapshot → spawn `claude -p --output-format stream-json --json-schema …` with `cwd = projectFolder` and the prompt on stdin → parse the stream → run the guards → move the tag. `REPORT_SCHEMA` and `buildPrompt` define the contract with Claude. The report view, overlay and note status all read the fields they produce.
- **State lives in only three places:** git (history, plus the `theory/compiled` tag as the last-compile marker), front matter (`realized: false`), and plugin data (settings plus the last 20 reports). Note compile state, pending counts and button states are worked out each time from these, never stored.
- **Problem anchors** (`src/anchor.ts`): Claude proposes `{path, heading?, quote?}`. `checkProblems` checks them against the snapshot before they're kept. `overlay.ts` (CodeMirror decorations plus banners) and `note-status.ts` use the checked anchors and the report's `suspectNotes`.
- **Pull request states** (`src/pr-states.ts`): asked for only when a report or the compile history opens, the report switches, the compile history's Refresh is clicked, or the window gets focus. Never on a timer. Only draft and open pull requests are checked, side by side, one refresh at a time; a focus refresh within 30 seconds of the last is skipped; a failed check keeps the saved state silently.
- **Expand** (`src/expand.ts`, `src/expand-view.ts`): on a model folder's `index.md`, asks Claude which notes are missing. Claude gets only that folder's notes (no hidden folders), the root `Index.md`, and Read/Glob/Grep inside that repository. Suggestions live only on screen. Create note writes an empty note and never commits.
- **`src/explorer.ts`** patches the file explorer's internal `getSortedFolderItems`. That's private Obsidian API, so it must be undone on unload.

## Invariants not to break

These are in full in WORKFLOW.md §7. In short:

- The AI never writes to the vault. Keep the read-only snapshot, the `--disallowedTools` deny rules on both the vault and the snapshot, the snapshot hash check and the vault working-tree check.
- Only committed revisions are compiled (`git archive HEAD`, never the working tree).
- The marker moves once Claude has run, whether it succeeded or failed. It never moves on cancel or when the compile can't start.
- Reports live only in plugin data, never in the vault.
- Overlays are display only. Build them with `setText` or attributes, never HTML or Markdown, and never write to a note to show them.
