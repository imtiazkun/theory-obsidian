# theory.md — App Workflow (LLM reference)

This file describes how the theory.md Obsidian plugin works. It is written so an LLM can reason about the app. Each step lists its trigger, what it checks first, what it does and what comes out. The source of truth is the code in `src/`. If this file and the code disagree, the code wins.

## 1. One-paragraph summary

theory.md is a desktop-only Obsidian plugin (plugin id `theory-md`). Humans write a **theoretical model** of a software system as notes in an Obsidian vault. The vault is a git repository. Humans **commit** changes to the model as signed git commits. **Compile** sends every commit made since the last compile to the Claude Code CLI. Claude Code then changes the code in a separate **project folder** to match the model. Claude returns a structured **compile report** (summary, changes, questions, problems), which the plugin shows in Obsidian. The AI never writes to the model.

## 2. Glossary

| Term | Meaning |
| --- | --- |
| Vault | The Obsidian vault folder. It holds the model and is its own git repo, on branch `main`. |
| Model / theoretical model | The Markdown notes and assets in the vault. Humans write them. Read-only for the AI. |
| `Index.md` | Entry note at the vault root. Opened on app launch. |
| `instruction.md` / `instructions.md` | File at the vault root with the human-only rules and the writing syntax rules. For humans; not sent to Claude and not required for compile. |
| Project folder | Folder that holds the code. It is one git repo, or a folder whose direct subfolders are git repos. Claude runs here (`cwd`). |
| Revision | A git commit in the vault repo. |
| Last compile marker | Git tag `theory/compiled` in the vault repo. It points at the last compiled commit. |
| Pending revisions | Commits in `theory/compiled..HEAD`. On the first compile (no tag yet), all commits up to `HEAD`. |
| Snapshot | A read-only copy of the vault at `HEAD`, made in a temp folder (`$TMPDIR/theory-model-*`). Claude reads the model from here. It leaves out the files never sent to Claude (`NOT_SENT` in `src/compile.ts`): hidden folders, `.obsidian/` and `Instructions.md`. |
| Hidden folder | A folder whose name starts with `_`, at any depth, like `_templates`. Committed, but never sent to Claude. |
| Compile report | JSON record of one compile run. Kept in plugin data, never in the vault. |
| Plugin data | `.obsidian/plugins/theory-md/data.json`. Holds the settings and the last 20 reports. Git ignores it. |
| Anchor | Where a problem sits in the model: `{path, heading?, quote?}`. Claude proposes it, and the plugin checks it against the snapshot before keeping it. |
| Realized | Front matter `realized: false` marks a note as written ahead of the code. If the key is missing, the note counts as realized. Engineers set it with a box in the note header. |
| Failure overlay | Highlights and a banner the plugin draws on notes that a failed compile points to. Display only: it never edits a note. |

## 3. Actors and components

- **Engineer** (human): edits notes, commits, clicks Compile, reads reports, answers questions by editing the model.
- **Plugin** (`src/main.ts`, class `TheoryPlugin`): wires commands, views, buttons and events, and holds the compile lock.
- **Git** (run as a subprocess through `git()` in `src/vault.ts`): stores the model's history, the marker tag, diffs and snapshots.
- **Claude Code CLI** (run as a subprocess in `src/compile.ts`): reads the snapshot, edits the project folder, runs the allowed commands and returns structured output.

| File | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, commands, compile lock, commit entry points, saving settings and reports |
| `src/vault.ts` | Git helpers: setup, changed files, commit with identity, file history, `TOOL_PATH` |
| `src/commit.ts` | Commit modal and the per-note commit button in each note's header |
| `src/compile.ts` | The compile pipeline: marker, diff, snapshot, prompt, Claude subprocess, report, checks |
| `src/anchor.ts` | Anchor and problem types, `findAnchor` (find a quote or heading in a note) and `checkProblems` (check Claude's anchors) |
| `src/overlay.ts` | Failure overlay: CodeMirror highlights, the note banner, jump to spot, dismiss |
| `src/note-status.ts` | Realized box and compile-state icon in each note's header |
| `src/explorer.ts` | Hidden folders (name starts with `_`): wraps the file explorer's internal `getSortedFolderItems` to list them last, and removes the wrapper on unload. styles.css greys them out by `data-path`. |
| `src/compile-button.ts` | Floating bottom-right bar: commit button plus compile button with a state and pending count |
| `src/report-view.ts` | Compile report tab, including permission cards and question suggestions |
| `src/suggest.ts` | A question's Suggest button: asks Claude Code, with no tools, for ideas on answering it |
| `src/history-view.ts` | Commit history of the active note, in the right sidebar |
| `src/compile-history-view.ts` | Compile history (when, who, tokens), beside the commit history in the right sidebar |
| `src/commit-message.ts` | The commit modal's sparkle: asks Claude Code, with no tools, for a message from the uncommitted diff |
| `src/settings.ts` | Settings tab |
| `src/project.ts` | Finds the git repos in the project folder; native folder picker |

## 4. Settings

| Key | Default | Used by |
| --- | --- | --- |
| `fullName` | `""` | Commit identity (`git -c user.name=…`). Falls back to the git config. |
| `email` | `""` | Commit identity (`git -c user.email=…`). Falls back to the git config. |
| `projectFolder` | `""` | `cwd` for Claude Code. Compile won't start without it. |
| `claudeCommand` | `"claude"` | CLI binary name or absolute path. |
| `permissionMode` | `"acceptEdits"` | Passed to `--permission-mode`. Options: `acceptEdits`, `auto`, `bypassPermissions`. |
| `allowedTools` | `"Bash(git *)"` | Passed to `--allowedTools`. Space-separated permission rules. |
| `model` | `""` | Passed to `--model` (`fable`, `opus`, `sonnet`, `haiku`). `""` passes nothing and Claude Code decides. |
| `effort` | `""` | Passed to `--effort` (`low`, `medium`, `high`, `xhigh`, `max`). `""` passes nothing. |
| `showCompileButton` | `true` | Shows or hides the floating bar. |

## 5. Lifecycle state machine (per vault)

```
UNCONFIGURED ──(Setup vault)──► VAULT_READY ──(set projectFolder)──► COMPILE_READY
                                                                         │
            ┌──────────────── edit note ◄───────────────────────────────┤
            ▼                                                            │
         DIRTY ──(commit)──► PENDING (n > 0 revisions) ──(Compile)──► COMPILING
                                                                         │
                       ┌─────────────────────────────────────────────────┤
                       ▼                   ▼                    ▼
                  SUCCEEDED             FAILED              CANCELLED
              (marker → HEAD)       (marker → HEAD)      (marker unchanged)
```

Compile button states (`src/compile-button.ts`, `readState`), checked in this order:
1. `hidden`: the vault isn't set up, or the button is turned off.
2. `running`: a compile is in progress. While a permission card waits, it says "Claude is asking (1:47)", counting down with the oldest card, and clicking it opens the report at that card.
3. `setup`: no project folder is set.
4. `ready(pending)`: there are pending revisions. Shows a badge with the count, in the accent colour.
5. `failed`: no pending revisions, and the newest report failed.
6. `idle`: nothing to do.

## 6. Workflows

### W1. Plugin load (`onload`)
1. Load the settings and reports from plugin data. Any report still marked `running` becomes `failed` with the problem "Obsidian closed before this compile finished."
2. Register the commands `setup-vault`, `show-commit-history`, `compile`, `show-compile-report` and `commit-current-note`, plus a ribbon hammer icon (Compile) and a status bar item.
3. When the layout is ready: open `Index.md` (only on app launch, not when the plugin is turned on mid-session), add the history view to the right sidebar, sync the commit buttons and attach and refresh the compile bar.
4. Event hooks: vault `modify/create/delete/rename`, workspace `layout-change/file-open` and window `focus` re-sync the buttons and the pending count (debounced).

### W2. Setup vault (command "Setup vault")
- **Check first:** the vault isn't already a git repo (no `.git`). An author name and email exist in the settings or the git config. Otherwise it fails with a notice.
- **Actions:** write the starter files from `src/starter.ts` if the root doesn't already have them under any name, ignoring case: `Index.md` ("Manifesting <vault name>") and `Instructions.md` (the human-only rules and the doctrine, skipped if `instruction.md` or `instructions.md` exists). Then `git init -b main`, then add the missing lines to `.gitignore` (`.DS_Store`, `.trash/`, `.obsidian/`), then `git add -A`, then `git commit --allow-empty -m "Initial commit"` signed with the author.
- **Output:** the vault is a git repo whose initial commit includes the starter files. The UI refreshes and `Index.md` opens.

### W3. Edit and commit
- **Trigger:** the commit button in a note's header (marked `is-dirty` when the note has changes), the commit button in the floating bar, or the command "Commit current note".
- **Check first:** the note is in the list of changed files (`git status --porcelain -z --untracked-files=all`). If not, the notice "No changes to commit in this note." The floating commit button commits the active note when it has changes, else every changed file, else shows "No changes to commit".
- **Modal:** a message box (default `Update <basename>`, or `Update model` for all files) with a sparkle button that asks Claude to write the message, an "Include all changed files" toggle when other files changed, and the line "Signed as Name <email>". Cmd/Ctrl+Enter submits.
- **Generate (sparkle):** the uncommitted diff of the files being committed (tracked files against `HEAD`, new files whole, minus hidden folders, `.obsidian/` and `Instructions.md`, cut at 50,000 characters) goes on stdin to `claude -p --output-format json --no-session-persistence --tools ""`, run in the temp folder, with Edit/Write/NotebookEdit denied on the vault. The answer replaces the message. It sends uncommitted text, but never compiles it. On failure: "Couldn't generate a message: <reason>".
- **Actions:** for one file, `git add -A -- <path>` then `git commit -m <msg> -- <path>`. For all files, `git add -A` then `git commit -m <msg>`. Both use `-c user.name/-c user.email`.
- **Output:** a notice "Committed <shortHash>". The buttons, the pending count and the history view refresh.

### W4. Compile (the core pipeline)
**Trigger:** the compile button, the ribbon hammer or the command "Compile".

**Phase A: checks in `main.ts`** (if one fails, it shows a notice and does nothing else)
1. If a compile is already running, show "A compile is already running." and open the report. This is an in-memory lock, one compile per app.
2. The vault must be set up.
3. Count the uncommitted files and warn that they aren't part of this compile. Only committed revisions are compiled.

**Phase B: start-up in `startCompile`** (if one of these throws, the compile doesn't start and the marker doesn't move)
4. The project folder must be set and must exist.
5. `head` = `git rev-parse HEAD`. If there are no commits, it errors.
6. `from` = the commit the `theory/compiled` tag points to, or `null` if there is no tag.
7. If `from === head`, it throws `NothingToCompileError` ("Every committed revision is already compiled.").
8. `revisions` = `git log --reverse from..head` (hash, author, ISO date, subject).
9. `diff` = `git diff --stat --patch <from or EMPTY_TREE> head -- <NOT_SENT>`, cut at 200,000 characters. `notes` = the `.md` files changed in that range (`git diff --name-only`, same pathspecs), kept as suspects for the overlay. `NOT_SENT` excludes hidden folders, `.obsidian/` and `Instructions.md`.
10. Snapshot: `git archive head -- <NOT_SENT>` into a new temp folder, extract it, then `chmod -R a-w`.
11. Record the guards: a SHA-256 hash of the snapshot tree, and the vault's working-tree state (path → mtime, or "deleted").

**Phase C: run Claude Code**
12. Make the report `{status: "running", fromCommit, toCommit: head, revisions, …}`, add it to the front of `reports` (keep 20), save, open the report tab and show "Compiling…" in the status bar.
13. Start `claudeCommand` with `cwd = projectFolder` and these arguments:
    - `-p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --verbose --no-session-persistence`
    - `--permission-mode <permissionMode>`
    - `--add-dir <snapshot>`
    - `--json-schema <REPORT_SCHEMA>` (fields: `status`, `summary`, `changes[]`, `questions[{question, notes[], anchors?[{path, heading?, quote?}]}]`, `problems[{problem, anchors[{path, heading?, quote?}]}]`)
    - `--disallowedTools Edit/Write/NotebookEdit(//<vault>/**)` and the same for `//<snapshot>/**`
    - `--model <model>` and `--effort <effort>` when they aren't empty. They're fixed when Claude Code starts, so a running compile keeps them.
    - `--allowedTools <allowedTools>` when it isn't empty
14. The prompt goes in through stdin (`buildPrompt`) as a stream-json `user` message, after an `initialize` control request. Stdin stays open for permission answers and is closed when the `result` event arrives. It holds the role, the snapshot path, the list of repos in the project folder, the rules (the model is read-only and is the source of truth; ask questions instead of guessing; only edit the project folder; read and follow each repository's `AGENTS.md` (and `CLAUDE.md`) before changing it; end code commits with the trailer `Model-Revision: <head>`; prefix entries with `[repo]` when there are several repos; failures go in `problems`; set `status: failed` when the code doesn't match; don't build notes with `realized: false`; give model problems `anchors` with a file, heading and exact short quote), then the list of revisions and the diff.
15. Stream: each `assistant` `tool_use` block (except `StructuredOutput`) becomes a log line (`Tool: detail`, last 500 kept, shown live). The `result` event holds `structured_output`.
15a. **Permission requests.** A tool call the settings don't allow arrives as a `control_request` with subtype `can_use_tool`; it's never refused without asking. An Edit/Write/NotebookEdit/MultiEdit on a file inside the vault or the snapshot is denied at once, with no card. Anything else becomes a `PermissionRequest` (tool, the exact command or file, Claude's reason: the tool's `description`, else `decision_reason`) shown as a card in Activity, on the log line where Claude asked (`PermissionRequest.line`, kept in step as old lines drop off), with a Notice. While a card waits, Activity is open and scrolled to the oldest card. The Deny button counts down the time left, from "Deny (2:00)" to "Deny (0:00)". Each card has its own 120-second timer and is answered on its own: **Allow** (allow once), **Always allow** (allow, add the request's rules (`PermissionRequest.rules`) to the session through `updatedPermissions`, and append them to the `allowedTools` setting; the rules follow CFG-16: for a command, every rule Claude Code suggests for Bash in the request's `permission_suggestions`, e.g. `Bash(npm run:*)` (a compound command like `cd app && npm test` may get one per part, and all are added), else the exact command, e.g. `Bash(npm run build)`; for a file tool (Edit, Write, NotebookEdit, MultiEdit), that tool on that exact absolute file, e.g. `Edit(//Users/me/.zshrc)`, never the bare tool name or Claude Code's suggestion, and no Always allow button when the request names no file; for any other tool, Claude Code's suggestion, else the tool's name; the card shows every rule before the click; they go at the end of the list and none is ever added twice) or **Deny**. No answer in 120 seconds denies it. Once answered, the card's line becomes "Allowed: {command}", "Always allowed: {command}", "Denied: {command}" or "Timed out: {command}" and is saved with the report's log. Every denial, timeout and blocked model write is added to the report's problems after Claude's own, naming the command. Cancel, plugin unload and Claude Code exiting deny every open request. A `control_cancel_request` withdraws the request: its timer stops and its card becomes "Withdrawn: {command}", kept in the log but not a problem, because nobody refused it.

**Phase D: finish** (`done` promise)
16. If cancelled, `status = cancelled` and the marker **doesn't move**.
17. If the CLI couldn't start, `status = failed` and the marker **doesn't move** (it returns early). ENOENT gives "Couldn't find the Claude Code CLI".
18. Claude has run, so `report.suspectNotes = notes`. If there is structured output, copy it into the report, but keep its `problems` aside for step 21. `status = succeeded` only if Claude said `succeeded` and the result isn't an error. Leading `./` is removed from note paths.
19. If there is no structured output, `status = failed` and the problems always get "Claude Code exited with code N." and stderr.
20. **Guard 1:** hash the snapshot again. Then run `checkProblems` on Claude's problems: the text is cut to 2,000 characters, and an anchor is kept only if its path resolves (after following symlinks) to a file inside the snapshot. Its heading and quote are kept only if they appear in that file, and at most 5 anchors are kept per problem. If the snapshot changed, every anchor is dropped, `status = failed`, and the problem "Claude tried to change the model snapshot…" is added. Each question's anchors go through the same check (`checkAnchors`); a question keeps `anchors` only when at least one survives.
21. **Guard 2:** compare the vault's working tree both ways, so a file that was dirty before and is clean after counts too. Any path whose state changed is named in the problems ("revert them"). This doesn't change the status on its own.
22. Move the marker with `git tag -f theory/compiled head`. This happens on **succeeded and failed** once Claude has run, but not on cancelled or when the CLI couldn't start.
23. Always: set `finishedAt`, remove the snapshot (`chmod u+w`, then `rm -rf`).
24. Back in `main.ts`: release the lock, save the reports, refresh the views and buttons, and show a notice: "Compile finished." or "Compile failed. See the compile report.", plus "Claude has N question(s)" when there are any.

### W5. Cancel a compile
`cancelCompile()` denies every open permission request, then sends SIGTERM to the Claude process if the report is still running. The result is `cancelled` and the marker stays where it was. Unloading the plugin also cancels.

### W6. Read the report and answer questions
The report tab lists reports newest first: status, the commit range `from..to`, revisions, summary, changes, questions (each links to the model notes it names and has a **Reply** button that opens the note at the rule that needs updating: its first checked anchor's quote, else that anchor's heading, else the top of the note; with no anchor, the top of its first note), problems and the tool log ("Activity", folded until opened, except while a permission card waits). Sections with nothing in them are left out.

Below Reply, each question has a **Suggest** button (`src/suggest.ts`). It runs `claude -p --output-format json --tools "" --strict-mcp-config` in the temp folder, with the model and effort from the settings and the prompt on stdin. The prompt holds only the question, its anchors, the current text of every note it names (read from the vault, uncommitted edits included) and the compile's summary. While it runs the button says "Suggesting…" and is disabled; a question has at most one suggestion. The suggestion shows under the question: the note and heading it is for, the text in an editable box and one sentence on why. **Accept** copies the box to the clipboard, opens the note at the same spot as Reply and shows "Suggestion copied. Write it in the note in your own words." It never writes to a note. **Reject** removes it. A failure shows "Couldn't get a suggestion: {reason}" and Suggest works again. Suggestions live only in the view: never in the report, plugin data or the vault, and closing the report discards them (and stops any still running).

Engineers answer questions by **editing the model, committing and compiling again** (back to W3, then W4). Reports are never written into the vault.

### W7. Failure overlay (`src/overlay.ts`)
- **Which report:** the newest finished report, only if it `failed` and isn't `dismissed`. The next successful compile clears the overlay by itself.
- **Editor highlight:** a CodeMirror `ViewPlugin` (`registerEditorExtension`) finds each anchor in the note's *current* text, quote first and then heading. It adds `theory-fail-line` to those lines and a `theory-fail-mark` wavy underline to the text, with the problem as a plain `title` tooltip. It updates on every edit and whenever `sync()` sends a refresh.
- **Banner:** a div above the note's content in every open note the report points to: "The last compile failed here (n)", with Report and Dismiss buttons and the list of problems. Clicking one jumps to its spot. If the quote or heading is no longer in the note, it says the spot has changed.
- **Fallback:** if *no* problem in the report has anchors, every note in `suspectNotes` gets a banner saying it changed in the failed compile and may be the cause. The report view lists these notes too.
- **Jump:** opens the note (reusing its tab), finds the anchor and selects it in editing modes, or scrolls to it in reading mode. Report-view links use the same jump.
- **Dismiss:** sets `report.dismissed = true` in plugin data and removes the highlights and banners. The report stays. Also offered as "Clear highlights" in the report header.
- **Syncs on:** layout ready, `layout-change`, `file-open`, vault `modify` (debounced), compile end and dismiss.

### W8. Note status in the header (`src/note-status.ts`)
- **Realized box** (engineer sets it): ☑ if the note's front matter doesn't say `realized: false`, ☐ if it does. A click toggles it through `processFrontMatter`: it writes `realized: false`, or deletes the key, so a realized note carries no extra text. CSS hides the `realized` property, and the whole Properties block when that's the only property. Source mode still shows the raw YAML.
- **Compile state** (worked out from git and the reports, nothing stored): `new` if git doesn't track the note; `pending` if it changed between `theory/compiled` and `HEAD`, or there's no tag yet (`running` while a compile is under way); otherwise `failed` or `compiled`, according to the newest finished report whose `suspectNotes` or anchors include the note (`compiled` if none does). A click opens the compile report.
- **Syncs on:** layout ready, `layout-change`, `file-open`, `metadataCache` `changed`, window focus, commit, and compile start and end.

### W9. Commit history view
The right sidebar shows `git log --follow` for the active note (author, relative time, subject) and marks uncommitted changes.

### W10. Compile history view
A second right-sidebar tab, beside the commit history, lists the reports in plugin data, newest first: status, relative start time, who ran it (`report.author`: the settings name, else git's `user.name`) and the total tokens (`report.tokens`: input, output and cache tokens from the `usage` of Claude's `result` event; "tokens unknown" when Claude never reported it, e.g. on cancel). A click opens that report. It redraws whenever the report views do.

## 7. Invariants (must always hold)

1. **The AI never writes to the model.** This is enforced by: the read-only snapshot outside the vault, `--disallowedTools` on the vault and the snapshot, the snapshot hash check (the compile fails if it changed) and the vault working-tree check (it reports changed files).
2. **Only committed revisions are compiled.** The snapshot is `git archive HEAD`, not the working tree.
3. **Every model revision has a human author.** Commits use `user.name`/`user.email` from the settings or the git config. A commit fails if neither is set.
4. **One compile at a time per app instance** (`compileRun` lock).
5. **The marker moves once Claude has run, whether it succeeded or failed. It never moves on cancel, when compile can't start, or when the CLI can't be launched.** Failed revisions are not retried by themselves. Re-applying them is a human decision.
6. **Reports live only in plugin data**, which git ignores. The last 20 are kept.
7. **Failure overlays are display only.** They are built from checked anchors, set with `setText` or as attributes (never as HTML or Markdown), and only stored in plugin data.
8. **Claude's text never goes into a note.** Not from a compile, not from a suggestion. Accept on a suggestion only copies it to the clipboard; the engineer writes the note.
9. **Code commits link back to the model** through the `Model-Revision: <vault commit>` trailer. Claude adds it because the prompt tells it to.

## 8. Failure and outcome table

| Situation | Where | Marker moves? | User sees |
| --- | --- | --- | --- |
| Compile already running | main | — | Notice, report tab opens |
| Vault not set up | main | No | "Set up the vault before compiling." |
| No project folder, or it doesn't exist | startCompile | No | "Compile failed: …" |
| No commits in the vault | startCompile | No | "The vault has no commits yet…" |
| Nothing new since the marker | startCompile | No | "Every committed revision is already compiled." |
| CLI not found or can't start | done | No | Failed report: "Couldn't find the Claude Code CLI" |
| Claude reports `failed`, or there is no structured output | done | Yes | Failed report with problems |
| Snapshot changed | done | Yes | Failed, "Claude tried to change the model snapshot" |
| Vault file changed during the run | done | Yes | Problem names the files, status unchanged |
| User cancels | done | No | Cancelled report |
| Obsidian closed mid-compile | next load | No (tag never moved) | Report marked failed |

## 9. Not yet built

- Single user and local only: one engineer, one vault and one project folder on one machine.
- Planned: a server with a shared git remote, the `theory/compiled` tag pushed for the whole team and a shared compile lock.
