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
| Model folder | A folder at the vault root named exactly like a repository in the project folder. Its notes describe that repository only. It has its own `index.md` and `instructions.md`; that `instructions.md` holds rules for Claude about the repository and is sent (only the root one isn't). |
| Compile branch | `theory/compile-{short hash of the latest revision compiled}` in a code repository. The plugin checks it out before Claude runs; Claude commits there. It stays open until it is merged into its base or its pull request is closed. At most one open per repository. |
| Project folder | Folder that holds the code. It is one git repo, or a folder whose direct subfolders are git repos. Claude runs here (`cwd`). |
| Revision | A git commit in the vault repo. |
| Last compile marker | Git tag `theory/compiled` in the vault repo. It points at the last compiled commit. |
| Pending revisions | Commits in `theory/compiled..HEAD`. On the first compile (no tag yet), all commits up to `HEAD`. |
| Snapshot | A read-only copy of the vault at `HEAD`, made in a temp folder (`$TMPDIR/theory-model-*`). Claude reads the model from here. It leaves out the files never sent to Claude (`NOT_SENT` in `src/compile.ts`): dot folders, hidden folders, hidden notes (name starts with `_`, like `_welcome.md`) and `Instructions.md`. |
| Hidden folder | A folder whose name starts with `_`, at any depth, like `_templates`. Committed, but never sent to Claude. |
| Dot folder | A folder whose name starts with `.`, at any depth, like `.obsidian/` or `.comments/` (`DOT_FOLDERS`, `isInDotFolder`). Never sent to any agent, never counted as a change (`changedFiles`), left out of the vault check, and a revision that changes only dot folders is never pending (`pendingRevisionCount`, `revisionsBetween`). theory.md commits `.comments/` itself; git ignores `.obsidian/`. |
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
- **ACP agent** (optional, run as a subprocess in `src/acp.ts`): when the Agent setting is "ACP agent", Compile runs the engineer's own Agent Client Protocol agent (e.g. `gemini --experimental-acp`) instead of Claude Code. Expand, Suggest, commit messages and pull request bodies always use Claude Code. The plugin never installs an agent.

| File | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, commands, compile lock, commit entry points, saving settings and reports |
| `src/vault.ts` | Git helpers: setup, changed files, commit with identity, file history |
| `src/tool-path.ts` | `toolPath()`, the PATH every subprocess gets: the login shell's PATH (read once on load, at most 5 seconds) or Obsidian's own when the shell fails, then the usual tool folders |
| `src/commit.ts` | Commit modal and the per-note commit button in each note's header |
| `src/compile.ts` | The compile pipeline: marker, diff, snapshot, prompt, Claude subprocess, report, checks |
| `src/acp.ts` | The ACP agent runner: JSON-RPC over stdio, permission cards, file reads and refused writes, model and thinking-level choices, the answer from the last JSON block, cancel |
| `src/anchor.ts` | Anchor and problem types, `findAnchor` (find a quote or heading in a note) and `checkProblems` (check Claude's anchors) |
| `src/overlay.ts` | Failure overlay: CodeMirror highlights, the note banner, jump to spot, dismiss |
| `src/note-status.ts` | Realized box and compile-state icon in each note's header |
| `src/explorer.ts` | Hidden folders (name starts with `_`): wraps the file explorer's internal `getSortedFolderItems` to list them last, and removes the wrapper on unload. styles.css greys them out by `data-path`. Also marks `index.md`/`instructions.md` at the root and directly in a model folder (bold, house or scroll icon) with one stylesheet on the explorer rows' `data-path` (`entryFileSelector`): the file name matches ignoring case, the model folder's name must match the repository exactly. |
| `src/compile-button.ts` | Floating bottom-right bar: commit button, Expand button (only on a model folder's `index.md`), and compile button with a state and pending count |
| `src/report-view.ts` | Compile report tab, including permission cards and question suggestions |
| `src/suggest.ts` | A question's Suggest button: asks Claude Code, with no tools, for ideas on answering it |
| `src/history-view.ts` | Commit history of the active note, in the right sidebar |
| `src/compile-history-view.ts` | Compile history (when, who, tokens), beside the commit history in the right sidebar |
| `src/commit-message.ts` | The commit modal's sparkle: asks Claude Code, with no tools, for a message from the uncommitted diff |
| `src/settings.ts` | Settings tab |
| `src/project.ts` | Finds the git repos in the project folder; native folder picker |
| `src/branches.ts` | Compile branches: uncommitted-change check, finding the open compile branch, checking out before Claude runs, deleting empty ones after |
| `src/pr-states.ts` | Refreshes pull request states: only draft and open ones, across every report, side by side, one refresh at a time, focus refreshes at most every 30 seconds |
| `src/expand.ts` | Expand: the context, prompt and Claude Code arguments, parsing the suggestions, and Create note (an empty note, never committed) |
| `src/expand-view.ts` | The Expand view: one card per suggested note with Create note, Copy and Dismiss |
| `src/github.ts` | `gh` and `origin` helpers: login check, pull request create/state/body, remote branches |
| `src/create-pr-view.ts` | The Create PR page, and which repositories of a report still need a pull request |
| `src/pr-body.ts` | The Create PR body's sparkle: asks Claude Code, with no tools, for a body from the report |
| `src/repositories.ts` | Repository KPIs, fetch, Add model folder and New repository steps and file texts |
| `src/templates.ts` | Fills `_templates/index.md` and `_templates/instructions.md` for a new model folder, with the built-in text when a template is missing or empty |
| `src/repositories-view.ts` | The Repositories page and the New repository form |
| `src/pull.ts` | Pulls the vault and the code repositories, fast-forward only: the vault pull, the code pulls, the gate before a compile, the sync status and sync menu text, saving the vault's `origin`, and the `Puller` that decides when a pull runs |

## 4. Settings

| Key | Default | Used by |
| --- | --- | --- |
| `fullName` | `""` | Saved by older versions only. Never signs; the Author section offers to write it into the vault's git config when git lacks a name or email (CFG-37). |
| `email` | `""` | Same as `fullName`. |
| `projectFolder` | `""` | `cwd` for Claude Code. Compile won't start without it. |
| `claudeCommand` | `"claude"` | CLI binary name or absolute path. Used by Compile when `agent` is `"claude"`, and always by Expand, Suggest, commit messages and pull request bodies. |
| `agent` | `"claude"` | Which agent compiles: `"claude"` (Claude Code) or `"acp"` (an ACP agent). Older data without it compiles with Claude Code. |
| `agentCommand` | `""` | The command that starts the ACP agent, with its arguments. Compile won't start with `agent: "acp"` while it's empty. |
| `agentModel` | `""` | The ACP agent's model, matched against its choices by value or name at compile. `""` means the agent's default. Kept apart from `model`. |
| `agentThinkingLevel` | `""` | The ACP agent's thinking level, matched like `agentModel`. Kept apart from `effort`. |
| `permissionMode` | `"acceptEdits"` | Passed to `--permission-mode`. Options: `acceptEdits`, `auto`, `bypassPermissions`. Claude Code only. |
| `allowedTools` | `"Bash(git *)"` | Passed to `--allowedTools`. Space-separated permission rules. Claude Code only. |
| `model` | `""` | Passed to `--model` (`fable`, `opus`, `sonnet`, `haiku`). `""` passes nothing and Claude Code decides. |
| `effort` | `""` | Passed to `--effort` (`low`, `medium`, `high`, `xhigh`, `max`). `""` passes nothing. |
| `showCompileButton` | `true` | Shows or hides the floating bar. |
| `pullAutomatically` | `true` | Pull on launch, on focus and on the timer. Pull now and the pull before a compile run either way. |
| `pullInterval` | `5` | Minutes between timer pulls: 1, 5, 15 or 30. |
| `pullCodeRepos` | `true` | Each pull also fetches the project folder's repositories with an upstream and fast-forwards the safe ones. |

Remote is a setting too, but it isn't in plugin data: it is the vault's `origin` in its git config. Save runs `git remote add origin <url>`, or `git remote set-url origin <url>` after a "Replace the remote?" yes, then a pull. It refuses an empty URL, spaces, a leading `-` and a password or token in an https URL, and never removes the remote.

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
2. Register the commands `setup-vault`, `show-commit-history`, `compile`, `show-compile-report`, `commit-current-note`, `show-repositories` and `pull-now`, plus a ribbon hammer icon (Compile), a ribbon Repositories icon and a status bar item.
3. When the layout is ready: open `Index.md` (only on app launch, not when the plugin is turned on mid-session), add the history view to the right sidebar, sync the commit buttons and attach and refresh the compile bar. On launch, pull (W14) and start the pull timer.
4. Event hooks: vault `modify/create/delete/rename`, workspace `layout-change/file-open` and window `focus` re-sync the buttons and the pending count (debounced).

### W2. Setup vault (command "Setup vault")
- **Check first:** the vault isn't already a git repo (no `.git`). Git runs and has a name and email (`gitIdentity`: the vault's `--local` config, else `--global`). Otherwise it fails with a notice.
- **Actions:** write the starter files from `src/starter.ts` if the root doesn't already have them under any name, ignoring case: `Index.md` ("Manifesting <vault name>"), `Instructions.md` (the human-only rules and the doctrine, skipped if `instruction.md` or `instructions.md` exists), `_templates/index.md` (the model folder index headings) and `_templates/instructions.md` (the line pointing at the root Instructions). Then, when the root has `Welcome.md` (ignoring case) and no `_welcome.md`, replace its text with the welcome text (`WELCOME_TEXT` in `src/starter.ts`) and rename it to `_welcome.md`; it is not a starter file, so Create missing files never writes it back. Then `git init -b main`, then add the missing lines to `.gitignore` (`.DS_Store`, `.trash/`, `.obsidian/`), then `git add -A`, then `git commit --allow-empty -m "Initial commit"` signed with the author.
- **Output:** the vault is a git repo whose initial commit includes the starter files and the welcome note. The UI refreshes and `_welcome.md` opens when setup wrote it, `Index.md` otherwise.
- **Create missing files** (settings, when the vault is set up but `missingStarters` finds starter files or `.gitignore` lines missing): checks the author, writes only the missing files and lines with the same starter text, never changes a file that exists, and commits only what it wrote as "Add missing starter files". The check runs each time the settings tab opens and after the button runs; nothing is stored.

### W3. Edit and commit
- **Trigger:** the commit button in a note's header (marked `is-dirty` when the note has changes), the commit button in the floating bar, or the command "Commit current note".
- **Check first:** the note is in the list of changed files (`git status --porcelain -z --untracked-files=all`). If not, the notice "No changes to commit in this note." The floating commit button commits the active note when it has changes, else every changed file, else shows "No changes to commit".
- **Modal:** a message box (default `Update <basename>`, or `Update model` for all files) with a sparkle button that asks Claude to write the message, an "Include all changed files" toggle when other files changed, and the line "Signed as Name <email>". Cmd/Ctrl+Enter submits.
- **Generate (sparkle):** the uncommitted diff of the files being committed (tracked files against `HEAD`, new files whole, minus dot folders, hidden folders, hidden notes and `Instructions.md`, cut at 50,000 characters) goes on stdin to `claude -p --output-format json --no-session-persistence --tools ""`, run in the temp folder, with Edit/Write/NotebookEdit denied on the vault. While Claude writes, the sparkle blinks (fades out and back in about once a second); it never spins and no bar shows. The answer replaces the message. It sends uncommitted text, but never compiles it. On failure: "Couldn't generate a message: <reason>".
- **Actions:** for one file, `git add -A -- <path>` then `git commit -m <msg> -- <path>`. For all files, `git add -A -- <each changed path outside .obsidian/>` (a deletion that is already staged is skipped, since git refuses its path) then `git commit -m <msg>`. Both use `-c user.name/-c user.email` with the identity `gitIdentity` reads, so what the settings and the modal show is what signs. With no name or email the notice is "Set your name and email in git first. theory.md settings show how." and nothing is committed.
- **Output:** a notice "Committed <shortHash>". The buttons, the pending count and the history view refresh.

### W4. Compile (the core pipeline)
**Trigger:** the compile button, the ribbon hammer or the command "Compile".

**Phase A: checks in `main.ts`** (if one fails, it shows a notice and does nothing else)
1. If a compile is already running (or starting), show "A compile is already running." and open the report. This is an in-memory lock, one compile per app.
1a. Pull the vault and the code repositories (W14), even with automatic pulls off. A sync needed, waiting revisions or a repository that is behind and can't fast-forward stops the compile with "Compile failed: …". A failed fetch shows "Couldn't reach the remote, so this compile uses the local vault and code." and carries on.
2. The vault must be set up.
3. Count the uncommitted files and warn that they aren't part of this compile. Only committed revisions are compiled.

**Phase B: start-up in `startCompile`** (if one of these throws, the compile doesn't start and the marker doesn't move)
4. The project folder must be set and must exist.
5. `head` = `git rev-parse HEAD`. If there are no commits, it errors.
6. `from` = the commit the `theory/compiled` tag points to, or `null` if there is no tag.
7. If `from === head`, or every revision in `from..head` changes only dot folders, it throws `NothingToCompileError` ("Every committed revision is already compiled.").
7a. Every repository in the project folder must have a clean working tree (`git status --porcelain`), else "These repositories have uncommitted changes: {repos}. Commit or stash them first."
8. `revisions` = `git log --reverse from..head -- <DOT_FOLDERS>` (hash, author, ISO date, subject), so revisions that change only dot folders aren't listed.
9. `diff` = `git diff --stat --patch <from or EMPTY_TREE> head -- <NOT_SENT>`, cut at 200,000 characters. `notes` = the `.md` files changed in that range (`git diff --name-only`, same pathspecs), kept as suspects for the overlay. `NOT_SENT` excludes dot folders, hidden folders, hidden notes and `Instructions.md`.
10. Snapshot: `git archive head -- <NOT_SENT>` into a new temp folder, extract it, then `chmod -R a-w`.
11. Record the guards: a SHA-256 hash of the snapshot tree, and the vault's working-tree state (path → mtime, or "deleted").
11a. Read each repository's model-folder `instructions.md` from the snapshot (matched ignoring case) for the prompt.
11b. **Compile branches** (`prepareBranches`): in every repository, check out its open compile branch (a `theory/compile-*` branch that still exists, isn't merged into its base, and whose pull request isn't closed or merged, asking `gh` and else the reports), or else create `theory/compile-{head:7}` from the branch checked out now (from the recorded base when the repository sits on a finished compile branch). A detached HEAD or an existing branch of that name stops the compile. On any failure every repository goes back and the snapshot is removed. The plugin does this, never Claude.

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
14. The prompt goes in through stdin (`buildPrompt`) as a stream-json `user` message, after an `initialize` control request. Stdin stays open for permission answers and is closed when the `result` event arrives. It holds the role, the snapshot path, the list of repos in the project folder with the compile branch checked out in each, the rules (the model is read-only and is the source of truth; ask questions instead of guessing; only edit the project folder; read and follow each repository's `AGENTS.md` (and `CLAUDE.md`) before changing it; root notes describe the whole system and a model folder's notes describe that repository only; also follow the model folder's `instructions.md`, which wins over `AGENTS.md`; commit on the checked-out branch and never create, switch, merge or push branches; end code commits with the trailer `Model-Revision: <head>`; prefix entries with `[repo]` when there are several repos; failures go in `problems`; set `status: failed` when the code doesn't match; don't build notes with `realized: false`; give model problems `anchors` with a file, heading and exact short quote), then each model folder's `instructions.md`, then the list of revisions and the diff.
15. Stream: each `assistant` `tool_use` block (except `StructuredOutput`) becomes a log line (`Tool: detail`, last 500 kept, shown live). The `result` event holds `structured_output`.
15a. **Permission requests.** A tool call the settings don't allow arrives as a `control_request` with subtype `can_use_tool`; it's never refused without asking. An Edit/Write/NotebookEdit/MultiEdit on a file inside the vault or the snapshot is denied at once, with no card. Anything else becomes a `PermissionRequest` (tool, the exact command or file, Claude's reason: the tool's `description`, else `decision_reason`) shown as a card in Activity, on the log line where Claude asked (`PermissionRequest.line`, kept in step as old lines drop off), with a Notice. While a card waits, Activity is open and scrolled to the oldest card. The Deny button counts down the time left, from "Deny (2:00)" to "Deny (0:00)". Each card has its own 120-second timer and is answered on its own: **Allow** (allow once), **Always allow** (allow, add the request's rules (`PermissionRequest.rules`) to the session through `updatedPermissions`, and append them to the `allowedTools` setting; the rules follow CFG-16: for a command, every rule Claude Code suggests for Bash in the request's `permission_suggestions`, e.g. `Bash(npm run:*)` (a compound command like `cd app && npm test` may get one per part, and all are added), else the exact command, e.g. `Bash(npm run build)`; for a file tool (Edit, Write, NotebookEdit, MultiEdit), that tool on that exact absolute file, e.g. `Edit(//Users/me/.zshrc)`, never the bare tool name or Claude Code's suggestion, and no Always allow button when the request names no file; for any other tool, Claude Code's suggestion, else the tool's name; the card shows every rule before the click; they go at the end of the list and none is ever added twice) or **Deny**. No answer in 120 seconds denies it. Once answered, the card's line becomes "Allowed: {command}", "Always allowed: {command}", "Denied: {command}" or "Timed out: {command}" and is saved with the report's log. Every denial, timeout and blocked model write is added to the report's problems after Claude's own, naming the command. Cancel, plugin unload and Claude Code exiting deny every open request. A `control_cancel_request` withdraws the request: its timer stops and its card becomes "Withdrawn: {command}", kept in the log but not a problem, because nobody refused it.

15b-acp. **With an ACP agent** (`runAcpAgent` in `src/acp.ts`), steps 13 to 15a are replaced by this. The agent command is split into words (quotes kept together) and started with `cwd = projectFolder`. The plugin sends `initialize` (file reading and writing offered, no terminal), then `session/new` with `cwd = projectFolder` and the snapshot in `additionalDirectories`. When `agentModel` or `agentThinkingLevel` is set, it picks the choice of the agent's `model` / `thought_level` session config option (or `session/set_model`) whose value or name is that text, ignoring case; the activity log names the choice picked, or says the agent had no match and uses its default. Claude Code's `model` and `effort` never reach an ACP agent. Then `session/prompt` with the same prompt as Claude Code plus the answer's JSON Schema, asking for it as one JSON block at the end of the last message. Each `tool_call` update becomes a log line; `agent_message_chunk` text is kept. The answer is the last JSON object in the agent's messages; when there is none, or it lacks status, summary, changes, questions or problems, there is no structured answer. Every `session/request_permission` becomes a card like 15a, except a request of kind edit, delete or move on a vault or snapshot file, which is rejected at once with no card and named in problems. Buttons go back as the agent's options: Allow → `allow_once`; Always allow → `allow_always`, else `allow_once`; Deny (and a timeout) → `reject_once`, else `reject_always`. Always allow lasts for this compile only and never changes `allowedTools`. `fs/read_text_file` reads any file; `fs/write_text_file` is refused outside the project folder and on the vault or the snapshot (symlinks followed), and each refusal is a problem. Permission mode and Allowed commands don't apply. The report has `agent: "acp"` and no token count. Once the prompt returns, the agent is stopped.

**Phase D: finish** (`done` promise)
15b. Whatever the outcome (`finishBranches`): record each repository's compile branch, base and the commits this compile added in `report.branches`. A branch this compile created that got no commits is deleted and its repository goes back to its base. A branch with commits stays checked out. Compile never pushes.
16. If cancelled, `status = cancelled` and the marker **doesn't move**.
16a. On cancel and when the agent couldn't start, the snapshot check and the vault check still run and add their problems (AGT-17, INV-12), but the status stays as it is and the marker doesn't move.
17. If the CLI couldn't start, `status = failed` and the marker **doesn't move** (it returns early). ENOENT gives "Couldn't find the Claude Code CLI", or for an ACP agent "Couldn't find the agent ("{command}"). Set its command in theory.md settings."
18. Claude has run, so `report.suspectNotes = notes`. If there is structured output, copy it into the report, but keep its `problems` aside for step 21. `status = succeeded` only if Claude said `succeeded` and the result isn't an error. Leading `./` is removed from note paths.
19. If there is no structured output, `status = failed` and the problems always get "Claude Code exited with code N." and stderr (for an ACP agent, never the exit code: "The agent gave no structured answer. It stopped because: {reason}." with the stop reason or the error that ended the turn, then the end of stderr; AGT-22).
20. **Guard 1:** hash the snapshot again. Then run `checkProblems` on Claude's problems: the text is cut to 2,000 characters, and an anchor is kept only if its path resolves (after following symlinks) to a file inside the snapshot. Its heading and quote are kept only if they appear in that file, and at most 5 anchors are kept per problem. If the snapshot changed, every anchor is dropped, `status = failed`, and the problem "Claude tried to change the model snapshot…" is added. Each question's anchors go through the same check (`checkAnchors`); a question keeps `anchors` only when at least one survives.
21. **Guard 2:** compare the vault's working tree both ways, so a file that was dirty before and is clean after counts too. Any path whose state changed is named in the problems ("revert them"). This doesn't change the status on its own.
22. Move the marker with `git tag -f theory/compiled head`. This happens on **succeeded and failed** once Claude has run, but not on cancelled or when the CLI couldn't start.
23. Always: set `finishedAt`, remove the snapshot (`chmod u+w`, then `rm -rf`).
24. Back in `main.ts`: release the lock, save the reports, refresh the views and buttons, and show a notice: "Compile finished." or "Compile failed. See the compile report.", plus "Claude has N question(s)" when there are any.

### W5. Cancel a compile
`cancelCompile()` denies every open permission request, then sends SIGTERM to the Claude process if the report is still running. With an ACP agent it answers every open request as cancelled and sends `session/cancel`; an agent still running 5 seconds later gets SIGTERM. The result is `cancelled` and the marker stays where it was. Unloading the plugin also cancels.

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

### W11. Create PR (`src/create-pr-view.ts`)
- **Button:** a finished report shows Create PR beside its status when one of its kept compile branches is still open, has commits not in its base, and has no pull request in any report yet. Worked out from git and `gh` once per report while the report tab is open.
- **Page:** opens in a new tab. A shared Title (the latest compiled revision's subject) and Body (empty), and one section per such repository: name, `branch → base`, its commits, Base (the `origin/*` branches git knows), Draft (off), Reviewers (comma-separated, empty) and "Use the shared title and body" (on; off shows its own Title and Body, filled from the shared ones). A repository without a GitHub `origin`, or no logged-in `gh`, shows why and is left out.
- **Sparkle:** each Body box runs `claude -p --output-format json --tools "" --strict-mcp-config` in the temp folder with the model and effort from the settings. Claude gets the summary, the revisions, the open problems and questions, and the changes for that repository (all of them for the shared Body). The answer replaces the box.
- **Create:** for each ready section, `git push -u origin <branch>`, then `gh pr create --head --base --title --body [--draft] [--reviewer]`. The pull request goes into `report.pullRequests` (repository, branch, base, url, state). A failure shows "Couldn't create the pull request: {reason}" and keeps the fields. Once every ready section has one, each body gets a footer (after `<!-- theory.md compile -->`, replaced on a second run) listing the vault revisions (linked when the vault has a GitHub `origin`) and the other repositories' pull requests.
- **State:** the report lists its pull requests with their state (draft, open, merged, closed). `src/pr-states.ts` refreshes them with `gh pr view` when a report opens or the report view switches report, when the compile history opens, on its Refresh action, and when the window gets focus back; never on a timer. Only draft and open pull requests, across every report, are checked, side by side; one refresh runs at a time; a focus refresh within 30 seconds of the last one is skipped, the Refresh action never is. A failed check keeps the saved state and shows nothing. A changed state is saved and redraws the report, the compile history and the Repositories page. Pull requests never move the marker. The page's text goes only to GitHub, never into the vault, and closing the page discards it.

### W12. Repositories page (`src/repositories-view.ts`)
- **Opens** from the ribbon or "Show repositories", in a tab. One card per repository in the project folder, sorted by name; clicking the name opens the model folder's `index.md`. No project folder: a message and an Open settings button. A single-repository project folder: a message, and New repository is disabled. None: "No repositories yet. Create one to start."
- **KPIs** (worked out each time, never stored): Code (branch, last commit when and who, uncommitted files), Compile (the newest report that added commits to it, or "Never compiled", and its open compile branch with the recorded pull request state), Model (notes in its model folder, how many are `realized: false`, how many are waiting for a compile), Remote (the GitHub `origin` link and ahead/behind `origin/<branch>`, or "No remote"). Opening never fetches or asks GitHub; the Refresh action runs `git fetch` in every repository first. A card whose repository could fast-forward (W14) shows Pull, which fast-forwards that repository only.
- **Add model folder:** for a repository without one, writes `index.md` and `instructions.md` from the templates (with `{{description}}` and `{{purpose}}` empty) and commits only those two as "Add model folder for {name}".
- **Templates:** Add model folder and New repository read `_templates/index.md` and `_templates/instructions.md` at that moment (`modelFolderTexts`). `{{name}}`, `{{description}}` and `{{purpose}}` are replaced as typed; a line holding only an empty field's placeholder is dropped with the blank line after it; everything else stays. A missing or whitespace-only template gives the built-in text: the "What this repository is" heading with the description and purpose (or "Manifesting {name}" when both are empty), and the line pointing at the root Instructions. The templates are never committed with the model folder.
- **New repository:** a form (name, description, purpose, stack, build/test/run commands, conventions, Create GitHub repository with visibility). Create checks the name, the author and `gh`, then makes `{name}/` in the project folder with `git init -b main`, `README.md` and `AGENTS.md` committed as "Initial commit"; then the model folder from the templates committed as "Add repository {name}"; then, when asked, `gh repo create --source . --remote origin --push`. The form's text goes in as typed. A failed step stops there and lists the steps done; nothing is deleted.

### W14. Pull (`src/pull.ts`)
- **When:** the vault pulls `main` from `origin` on launch, on window focus (skipped within 30 seconds of the last pull) and on the timer, when Pull automatically is on; on Pull now (the command or the sync menu) and before every compile, always. A vault without `origin` never pulls. No pull runs during a compile; one that falls due waits for it to end. One pull at a time.
- **Git:** `git fetch --no-tags origin` with prompts off (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode=yes`), so credentials fail with git's message instead of hanging. Then exactly one of: nothing new; fast-forward (`git merge --ff-only origin/main`) when only the remote moved and none of its commits touch a file with uncommitted changes, with the notice "Pulled N revisions by {authors}. Changed: {notes}." (the engineer's own revisions left out of the names); waiting, when they do touch one; sync needed, when both sides moved; offline, when the fetch failed. Never merges, rebases, commits, pushes, stashes, switches branches or moves the marker.
- **Code:** with Also pull code repositories on, each pull also fetches every repository with an upstream, and fast-forwards it only when it isn't on a compile branch, has no uncommitted changes, and is behind with nothing of its own. Silent.
- **Sync status:** left of the commit button: "No remote", "Not pulled yet", "Pulling…", "Synced {time} ago" (plus " · {n} not pushed"), "{n} waiting", "Sync needed", "Offline, {time} ago". Never "Up to date". Whether the vault has an `origin` is checked on load and after Remote is saved, without fetching.
- **Sync menu:** a click on the sync status. "Checked the remote {time} ago" (or "Not checked yet"), "Last pulled {n} revisions {time} ago" (or "Nothing pulled since Obsidian opened"), Pull now ("Pulling…" and disabled while one runs) and Pull settings…. Without an `origin`: "This vault has no remote." and Add a remote…, which opens the settings at Remote. Nothing is stored; it is lost on reload.

### W10. Compile history view
A second right-sidebar tab, beside the commit history, lists the reports in plugin data, newest first: status, relative start time, who ran it (`report.author`: git's `user.name`, the vault's config first) and the total tokens (`report.tokens`: input, output and cache tokens from the `usage` of Claude's `result` event; "tokens unknown" when Claude never reported it, e.g. on cancel). A click opens that report. It redraws whenever the report views do. Each compile shows its pull request states, which refresh when the view opens and on its Refresh action (see W11).

### W13. Expand (`src/expand.ts`, `src/expand-view.ts`)
- **Button:** on a model folder's `index.md` only (`expandRepoFor`), the bar shows Expand beside the commit button. It opens the Expand view for that repository in a tab and asks Claude at once. While it runs, the button and the view say "Expanding…"; one run per repository.
- **Context:** the model folder's `index.md` and `instructions.md`, the current text of every other note in it (working tree, uncommitted edits included), the root `Index.md` and the names of all its notes. Hidden folders and notes (`_` or `.`) and the root Instructions are never sent.
- **Claude:** `claude -p --output-format json --strict-mcp-config` with the model and effort from the settings. When the repository exists, it runs there with `--tools Read,Glob,Grep --permission-mode dontAsk --allowedTools Read(//<repo>/**)`; otherwise in the temp folder with `--tools ""`. At most 10 suggestions (name, question, why, headings); ones that already exist are dropped.
- **View:** cards with Create note (asks for the name, creates an empty note in the model folder and opens it, "{name} already exists." when it does; never commits), Copy (plain text, "Copied. Write the note in your own words.") and Dismiss. Suggestions live only on screen; closing the view discards them and stops the run.

## 7. Invariants (must always hold)

1. **The AI never writes to the model.** This is enforced by: the read-only snapshot outside the vault, `--disallowedTools` on the vault and the snapshot, the snapshot hash check (the compile fails if it changed) and the vault working-tree check (it reports changed files).
2. **Only committed revisions are compiled.** The snapshot is `git archive HEAD`, not the working tree.
3. **Every model revision has a human author.** Commits use the `user.name`/`user.email` git uses: the vault's own config, else the global one. A commit fails when either is missing. The settings never edit them.
4. **One compile at a time per app instance** (`compileRun` lock).
5. **The marker moves once Claude has run, whether it succeeded or failed. It never moves on cancel, when compile can't start, or when the CLI can't be launched.** Failed revisions are not retried by themselves. Re-applying them is a human decision.
6. **Reports live only in plugin data**, which git ignores. The last 20 are kept.
7. **Failure overlays are display only.** They are built from checked anchors, set with `setText` or as attributes (never as HTML or Markdown), and only stored in plugin data.
8. **Claude's text never goes into a note.** Not from a compile, not from a suggestion. Accept on a suggestion only copies it to the clipboard; the engineer writes the note.
9. **Code commits link back to the model** through the `Model-Revision: <vault commit>` trailer. Claude adds it because the prompt tells it to.
10. **Every compile lands on a compile branch,** checked out by the plugin, never by Claude. Compile never pushes; only Create PR does. A compile never starts on a repository with uncommitted changes.

## 8. Failure and outcome table

| Situation | Where | Marker moves? | User sees |
| --- | --- | --- | --- |
| Compile already running | main | — | Notice, report tab opens |
| The pull before it: sync needed, revisions waiting, or a repository can't fast-forward | main | No | "Compile failed: …" |
| The pull before it can't reach a remote | main | — | Notice, the compile carries on with what is local |
| Vault not set up | main | No | "Set up the vault before compiling." |
| No project folder, or it doesn't exist | startCompile | No | "Compile failed: …" |
| No commits in the vault | startCompile | No | "The vault has no commits yet…" |
| Nothing new since the marker | startCompile | No | "Every committed revision is already compiled." |
| A repository has uncommitted changes | startCompile | No | "Compile failed: These repositories have uncommitted changes: …" |
| A compile branch can't be checked out | startCompile | No | "Compile failed: …", every repository back where it was |
| CLI not found or can't start | done | No | Failed report: "Couldn't find the Claude Code CLI" |
| Claude reports `failed`, or there is no structured output | done | Yes | Failed report with problems |
| Snapshot changed | done | Yes | Failed, "Claude tried to change the model snapshot" |
| Vault file changed during the run | done | Yes | Problem names the files, status unchanged |
| User cancels | done | No | Cancelled report |
| Obsidian closed mid-compile | next load | No (tag never moved) | Report marked failed |

## 9. Not yet built

- Single user and local only: one engineer, one vault and one project folder on one machine.
- Planned: a server with a shared git remote, the `theory/compiled` tag pushed for the whole team and a shared compile lock.
