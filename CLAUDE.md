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
```

There are no tests and no linter. `tsc` (via `npm run build`) is the only check.

The build writes a complete plugin folder to `dist/` (`main.js`, plus `manifest.json` and `styles.css` copied in). To try it, copy those files into `<vault>/.obsidian/plugins/mecho/` and reload the plugin in Obsidian. `dist/data.json` is local plugin data (settings and reports) from a test install. Don't commit or rely on it.

## Naming

The product is **theory.md**, but the plugin id, folder, class (`MechoPlugin`), view types, CSS classes (`mecho-*`) and temp folders (`$TMPDIR/mecho-model-*`) still use the old name `mecho`. Keep using `mecho` for identifiers. Changing the id would break existing installs and plugin data.

## Architecture

`src/main.ts` holds the plugin lifecycle: commands, views, event wiring and the in-memory compile lock (`compileRun`). It calls into one module per feature. The file-to-responsibility table is in WORKFLOW.md §3.

Things that need several files to understand:

- **Git is a subprocess, not a library.** Everything goes through `git()` in `src/vault.ts`. Subprocesses (git and claude) run with `PATH: TOOL_PATH`, because Obsidian launched from the Dock doesn't inherit the shell PATH. Use the same env for any new subprocess.
- **The compile pipeline** (`src/compile.ts`) runs in this order: `theory/compiled` tag → `git log`/`git diff` of `from..HEAD` → `git archive HEAD` into a read-only temp snapshot → spawn `claude -p --output-format stream-json --json-schema …` with `cwd = projectFolder` and the prompt on stdin → parse the stream → run the guards → move the tag. `REPORT_SCHEMA` and `buildPrompt` define the contract with Claude. The report view, overlay and note status all read the fields they produce.
- **State lives in only three places:** git (history, plus the `theory/compiled` tag as the last-compile marker), front matter (`realized: false`), and plugin data (settings plus the last 20 reports). Note compile state, pending counts and button states are worked out each time from these, never stored.
- **Problem anchors** (`src/anchor.ts`): Claude proposes `{path, heading?, quote?}`. `checkProblems` checks them against the snapshot before they're kept. `overlay.ts` (CodeMirror decorations plus banners) and `note-status.ts` use the checked anchors and the report's `suspectNotes`.
- **`src/explorer.ts`** patches the file explorer's internal `getSortedFolderItems`. That's private Obsidian API, so it must be undone on unload.

## Invariants not to break

These are in full in WORKFLOW.md §7. In short:

- The AI never writes to the vault. Keep the read-only snapshot, the `--disallowedTools` deny rules on both the vault and the snapshot, the snapshot hash check and the vault working-tree check.
- Only committed revisions are compiled (`git archive HEAD`, never the working tree).
- The marker moves once Claude has run, whether it succeeded or failed. It never moves on cancel or when the compile can't start.
- Reports live only in plugin data, never in the vault.
- Overlays are display only. Build them with `setText` or attributes, never HTML or Markdown, and never write to a note to show them.
