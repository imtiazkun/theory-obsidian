# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

theory.md is a desktop-only Obsidian plugin. Humans write a "theoretical model" of a software system as notes in a git-backed vault. **Compile** sends the vault commits made since the last compile to the Claude Code CLI, which reads the model and a separate project folder and plans the work; the plugin creates it on GitHub as one issue, or an epic with sub-issues. **Build** then has Claude write the code for each issue on its own branch, with a pull request. The AI never writes to the model.

- `WORKFLOW.md` is the detailed spec: every workflow step by step, the invariants and the failure table. Read it before changing the compile pipeline, the marker, guards or overlays. If it disagrees with the code, the code wins. Update it when behaviour changes.
- `README.md` is the user-facing doc, with a feature status table. `theory.md` is the product pitch and philosophy.

## Commands

```bash
npm install
npm run build   # tsc type-check (noEmit, src and tests), then esbuild production bundle
npm run dev     # esbuild watch, inline sourcemaps (no type-check)
npm test        # Vitest, every test once
npm test -- test/build.test.ts                # one test file
npm test -- test/build.test.ts -t "Retry"     # one test, by name
```

There is no linter. Before every commit run `npm run build` and `npm test`; both must pass. Never commit past a failing test.

## Tests

The rules are in the model's `obsidian-plugin/instructions.md` (TEST-1 to TEST-8). In short:

- Tests live in `test/*.test.ts`. Every change to branch, commit, compile, issue, build or anchor logic comes with a test that would have failed before it.
- Tests that need git make real repositories with `tempFolder()` and `initRepo()` from `test/helpers.ts`. The folder is new under the system temp folder and deleted after each test. Never point a test at the vault, the project folder or a real repository.
- `test/setup.ts` puts fake `claude` and `gh` first on PATH (they always fail) and gives git a test config instead of the engineer's. Tests never reach Claude Code, GitHub or the network.
- ACP agent tests (`test/acp.test.ts`) run a small fake agent written into the test's temp folder and started with `process.execPath`, never a real agent.
- `obsidian` is replaced by the small stub in `test/obsidian.ts` (see `vitest.config.ts`). Add to it only what a tested module needs to load. Views, modals and the file explorer aren't tested automatically; check them by hand in Obsidian.
- To test logic that lives in a view or in `main.ts`, move it into a plain exported function first (like `withAllowedRules` or `entryFileSelector`).

The build writes a complete plugin folder to `dist/` (`main.js`, plus `manifest.json` and `styles.css` copied in). To try it, copy those files into `<vault>/.obsidian/plugins/theory-md/` and reload the plugin in Obsidian. `dist/data.json` is local plugin data (settings and reports) from a test install. Don't commit or rely on it.

## Naming

The product is **theory.md**. The plugin id and folder are `theory-md`, classes use `Theory…` (`TheoryPlugin`), and view types, CSS classes and temp folders use the `theory-` prefix (`theory-report`, `$TMPDIR/theory-model-*`). The plugin used to be called `mecho`. Older installs live in `plugins/mecho/`, and vaults set up back then have a `.gitignore` entry for `plugins/mecho/data.json`.

## Architecture

`src/main.ts` holds the plugin lifecycle: commands, views, event wiring and the in-memory compile and build lock (`compileRun`, `buildRun`). It calls into one module per feature. The file-to-responsibility table is in WORKFLOW.md §3.

Things that need several files to understand:

- **Git is a subprocess, not a library.** Everything goes through `git()` in `src/vault.ts`. Subprocesses (git, claude and gh) run with `PATH: toolPath()` from `src/tool-path.ts`, because Obsidian launched from the Dock doesn't inherit the shell PATH. `onload` reads the login shell's PATH once (5 second limit) and adds `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin` and `~/.local/bin` after it; when the shell fails, they go after Obsidian's own PATH. Use the same env for any new subprocess.
- **The compile pipeline** (`src/compile.ts`) runs in this order: the marker (`markerCommit` in `src/shared-report.ts`) → the checks (uncommitted code, `gh`, GitHub origins, the GitHub Project) → `git log`/`git diff` of `from..HEAD` → the code snapshot (`src/code-snapshot.ts`: each repository's default branch, as GitHub names it, `git archive`d from `origin/{branch}` into a read-only `$TMPDIR/theory-code-*/{repo}/`; the last fetch or the local branch offline; never a checkout, ref or config change) → `git archive HEAD` into a read-only temp snapshot → the rule map, scope and fixed context (`src/rule-map.ts`, `src/fixed-context.ts`: the changed rules from the diff, their IDs searched in the code snapshot's tracked files, the repositories the plan may change, the root Index and each in-scope repository's AGENTS.md, CLAUDE.md and paths; the diff shows each change with its whole section, `src/model-diff.ts`) → spawn `claude -p --output-format stream-json --json-schema … --tools Read,Glob,Grep --permission-mode dontAsk` with `cwd` = the code snapshot and the prompt on stdin → parse the stream → run the guards (both snapshots hashed, writes to both denied) → check the plan (`src/plan.ts`, every issue inside the scope) → create the issues with `gh` → set `report.markerMoved` → share the report (`options.share`). A compile never changes code. `COMPILE_SCHEMA` and `compilePrompt` define the contract with Claude. `startSession` runs the agent with the permission cards; Build uses it too.
- **The build** (`src/build.ts`) builds one compile's issues: its checks, then for each issue a `theory/{n}-{short name}` branch (from the default branch, or from the epic branch `theory/epic-{n}-{short name}`), Claude in that repository with `BUILD_SCHEMA` and `buildPrompt`, push, pull request, and for a sub-issue merge into the epic branch and close. It never merges into a default branch. GitHub goes through the `GitHub` interface in `src/github.ts` (`ghGitHub` runs `gh`); tests pass `FakeGitHub` from `test/fake-github.ts`, and a fake Claude Code from `test/fake-claude.ts`. With the Compile or Build row's agent on "ACP agent" (rows and "Same as Compile" are resolved by `resolveTask` in `src/agent-rows.ts`), `src/acp.ts` runs the engineer's ACP agent instead (JSON-RPC over stdio, the same prompt plus the schema, the answer from the last JSON block); it has no deny rules, so the snapshot and vault checks are what protect the model. The report view, overlay and note status all read the fields they produce.
- **State lives in only three places:** git (history, plus the shared compile reports in `.compiles/`, whose committed files set the last-compile marker), front matter (`realized: false`), and plugin data (settings, every report with its permission answers and pull request states, keeping the last 20 that aren't shared). Note compile state, pending counts and button states are worked out each time from these, never stored.
- **Shared reports** (`src/shared-report.ts`): each compile Claude ran gets `.compiles/{UTC start}-{short id}.json` and its `.activity.log` (paths rewritten relative to the project folder and snapshots, `~` for home). `shareReport` writes and commits only that report's files, signed by git's identity, then pushes, at the REP-46 moments: `startCompile` calls `options.share` when creating an issue fails and once it ends (`compileMoment` picks Compile, Update or Recompile), `runBuild` once a build ended, and the Create PR page once it opened pull requests. A failed commit or push leaves the report in plugin data with `notShared` and the notice "Compile report saved but not shared: {reason}". A file it can't read is never overwritten. `markerCommit` is the `to` of the committed report with `markerMoved: true` that comes last in history; the `theory/compiled` tag is never read or moved, unless the Share compile reports setting (`settings.shareReports`, CFG-44) is off: then nothing is shared (`ctx.sharing: false`), and the tag is the marker, moved when a compile ends. The first load with shared reports carries the tag over once as a marker-only report (`importMarker`, CFG-45). The report view and compile history list plugin data and `.compiles/` together (`listReports` in `src/report-list.ts`); a teammate's report is read with `fromSharedReport` and joins plugin data when worked on (`adoptReport`). Before writing a report that is shared already, `shareReport` pulls (`ctx.pull`), refuses when that file changed on the remote and the vault can't fast-forward (REP-50), and takes in teammates' builds (`absorbShared`); a rejected push of a compile checks `compiledMeanwhile` (CMP-91).
- **Problem anchors** (`src/anchor.ts`): Claude proposes `{path, heading?, quote?}`. `checkProblems` checks them against the snapshot before they're kept. `overlay.ts` (CodeMirror decorations plus banners) and `note-status.ts` use the checked anchors and the report's `suspectNotes`.
- **Pushes** (`src/push.ts`): every commit the plugin makes pushes the vault's `main` to `origin` afterwards (`TheoryPlugin.push`, one at a time), never forced, never with tags, with `NO_PROMPT_ENV`. A failed push never undoes the commit. The Commit page (`src/commit-view.ts`) is a tab, not a modal; its git reading lives in `src/commit-diff.ts` so it can be tested.
- **Pulls** (`src/pull.ts`) only ever fetch and fast-forward, and run git with `NO_PROMPT_ENV` so a credential prompt fails instead of hanging Obsidian. `Puller` decides when a pull runs (never during a compile, focus at most every 30 seconds) and is shared by the timer, focus, Pull now and the pull at the start of `compile()` in `main.ts`. `compileGate` turns that last pull into a reason not to compile, or the offline notice.
- **Dot folders** (`.obsidian/`, `.comments/`, any folder starting with `.`) are never theory: `DOT_FOLDERS` in `src/compile.ts` keeps them out of the snapshot, diffs and pending revisions, and `isInDotFolder` in `src/vault.ts` keeps them out of the changed files and the vault check. Comments (`src/comments.ts`) live in `.comments/` and commit themselves, one file per commit.
- **The author is git's.** `gitIdentity` reads `user.name`/`user.email` from the vault's own config, else the global one, and every commit passes them with `-c`. The settings never edit them; `fullName`/`email` in plugin data are only an older version's values, offered once for the vault's config.
- **Hooks** (`src/hooks.ts`): `TheoryPlugin.hooks.fire(event, details)` is called after commits (`commitChanges`, setup and missing starter files), pushes (`TheoryPlugin.push`), comment commits (`comments-ui.ts`), compile start and end (`runCompile`), build start and end and permission requests (`runBuild`). It returns at once and never throws: a hook must never block or change what triggered it. Hooks live in `settings.hooks` (plugin data), never in the vault.
- **`src/explorer.ts`** patches the file explorer's internal `getSortedFolderItems`, and adds the change dots to the rows of its private `fileItems`. That's private Obsidian API, so it must be undone on unload.
- **The first load** (`src/first-load.ts` decides, `src/workspace-setup.ts` acts): on the first load after `install.sh` (`setupOnLoad` in plugin data, dropped before anything runs) and from the command "Use theory.md's core plugins", it sets the core plugins (`app.internalPlugins`), the left ribbon order (`app.workspace.leftRibbon.items`) and Graph view's colour groups, then (first load only) runs Setup vault. All of that is private API: keep it in `src/workspace-setup.ts`, check the shape first and fail quietly (SET-24, UI-44).

## Invariants not to break

These are in full in WORKFLOW.md §7. In short:

- The AI never writes to the vault. Keep the read-only snapshot, the `--disallowedTools` deny rules on both the vault and the snapshot, the snapshot hash check and the vault working-tree check. The code snapshot gets the same deny rules and hash check (INV-14).
- Only committed revisions are compiled (`git archive HEAD`, never the working tree).
- The marker moves once Claude has run, whether it succeeded or failed, when its shared report is committed with `markerMoved: true`. Discard commits it again with `markerMoved: false`. It never moves on cancel, when the compile can't start, or in a build or pull request.
- A compile never changes a code repository, and reads the code only in the code snapshot, which is always deleted. Only a build does, on branches the plugin makes, and it never merges into a default branch.
- Reports are never written into the model: the shared part lives in the `.compiles/` dot folder, the rest in plugin data. Pushes never force and never push tags.
- Overlays are display only. Build them with `setText` or attributes, never HTML or Markdown, and never write to a note to show them.
