# theory.md

theory.md is an Obsidian plugin for keeping a **theoretical model** of the software a team builds. Only humans write the model. The AI reads it and changes the code to match.

The theory behind it, and the method this plugin implements, is written up at [github.com/imtiazkun/theory.md](https://github.com/imtiazkun/theory.md).

## Why

Margaret-Anne Storey's post [How Generative and Agentic AI Shift Concern from Technical Debt to Cognitive Debt](https://margaretstorey.com/blog/2026/02/09/cognitive-debt/) (Feb 2026) argues that when AI writes the code, the bigger risk is no longer messy code. The bigger risk is **cognitive debt**: the team stops understanding what the system does and why. Her short version: "Technical debt lives in the code; cognitive debt lives in developers' minds."

The post builds on Peter Naur's *Programming as Theory Building*. Naur says a program is really a theory held in its developers' heads, and the code is only a by-product of that theory. When agents write the code and nobody holds the theory, the system turns into a black box.

theory.md keeps the theory on the page. Engineers write down what the software is, how it behaves and why. Claude builds the code from that, so the people who understand the system stay the source of truth.

## The theoretical model

The theoretical model is an Obsidian vault that describes the product:

- It is mostly Markdown text, with SVG and image assets for diagrams.
- It says *what* the system does and *why*: concepts, behaviour, rules, decisions.
- It lives in **its own git repository**, separate from the code it describes.
- `Index.md` at the vault root is the entry point. On launch theory.md opens Graph view, which shows the whole model and how its notes link, or `Index.md` when Graph view is turned off.
- `Instructions.md` at the vault root holds the human-only rules and the writing syntax rules for the model. It is for humans and isn't sent to Claude.

### Humans only

The AI reads the model and never writes to it. For an AI, editing the theoretical model is heresy.

theory.md enforces this in three ways:

1. **Read-only snapshot.** Compile never points Claude at the vault. It copies the compiled revision into a temporary folder outside the vault, makes it read-only, and gives Claude that copy. Claude Code permission rules also deny edits to both the copy and the vault.
2. **Post-run check.** After a compile, theory.md checks that the snapshot is exactly as it went in, and that no vault file changed while Claude ran. If the snapshot changed, the compile fails and the copy is thrown away. If a vault file changed, the report names it so you can revert it.
3. **Signed human commits.** Every revision of the model is a git commit signed with the engineer's name and email from theory.md settings. The history shows which person wrote each line.

## How it works

```
 Edit notes ──► Commit (signed) ──► Compile
                                       │
     read-only snapshot of the model ◄─┤  revisions since the last compile
                                       │
                                       ▼
                  Claude Code updates the project folder to match the model
                                       │
                                       ▼
                  Compile report in Obsidian: summary, questions, problems
```

1. **Write.** An engineer edits notes in the vault.
2. **Commit.** The commit button in a note's header records the change as a signed git commit with a message describing what changed.
3. **Compile.** Clicking Compile sends Claude every revision committed since the last compile. Claude changes the code in the project folder to match the model. theory.md then marks this point in the history as the new last compile.

## Status

theory.md runs on each engineer's own machine, and a **team shares one model** through the vault's git remote. Every commit is signed and pushed, and every engineer pulls the others' revisions. The issues and pull requests a compile and build create are shared on GitHub. Hooks can post comments, commits and compiles to a shared channel, like Slack, so the team discusses each decision where everyone sees it. The last-compile marker is shared through the compile reports in `.compiles/`. Until the server comes, the compile lock stays on each machine, so the team agrees who compiles.

| Feature | Status |
| --- | --- |
| Setup vault: turns the vault into a git repo with a `.gitignore`, a starter `Index.md` and `Instructions.md`, the templates in `_templates/`, and an initial commit | Done |
| Install with a coding agent: `INSTALL.md` and `scripts/install.sh` download and check the latest release, turn the plugin on, and on a first install run Setup vault on the first load | Done |
| First load after `scripts/install.sh`: turns on only the core plugins theory.md uses (Command palette, File recovery, Files, Graph view, Note composer, Page preview, Quick switcher, Search, Templates and Word count), puts Graph view, Quick switcher, Insert template, Command palette and Repositories at the top of the ribbon, and colours templates grey, index files blue and instructions files green in Graph view, keeping your own colour groups. The command **Use theory.md's core plugins** does the same at any time, after asking | Done |
| Create missing files: a vault set up by an older version, or missing a starter file, gets only the missing files and `.gitignore` lines from the settings, committed on their own | Done |
| Templates: a new model folder's `index.md` and `instructions.md` start from `_templates/index.md` and `_templates/instructions.md`, with `{{name}}`, `{{description}}` and `{{purpose}}` filled in | Done |
| Author: commits are signed with the name and email git uses (the vault's git config, else the global one). The settings show them as plain text, explain how to set what is missing, and can write a name and email saved by an older version into the vault's git config | Done |
| Commit button in each note's header, marked when the note has changes | Done |
| Commit page: every changed file with a checkbox and its diff, the rules each note adds, changes and removes, and a message that says why. Every commit pushes the vault to `origin` | Done |
| Past commits: clicking a commit in commit history shows it read-only with its diff | Done |
| Generate the commit message with Claude (sparkle button on the Commit page) | Done |
| Commit history view in the right sidebar | Done |
| Compile history view in the right sidebar: when, who and tokens spent, for your compiles and your teammates' | Done |
| On launch: Graph view as the active tab (or `Index.md` when Graph view is off), both sidebars expanded with the file explorer on the left and the Comments view on the right. Once per launch, never when the plugin is turned on mid-session or the vault is reopened in the same window | Done |
| Compile: send revisions since the last compile to Claude Code, which only reads and plans the work; theory.md creates it on GitHub as one issue, or an epic with sub-issues, added to your GitHub Project | Done |
| Build: Claude Code writes the code for each issue on its own branch; one issue becomes a pull request you merge, an epic's sub-issues are merged into an epic branch you merge; Retry, Skip and Stop when an issue fails; building the same compile again continues it on the same branches | Done |
| Recompile in a compile report: plans that compile's work again with the answers you committed since, continuing its issues where it can. Offered while no later compile succeeded, nothing of it was built and it wasn't recompiled; disabled until a revision is pending. The two reports link to each other, and Build then builds from the new one | Done |
| Last compile marker (shared reports in `.compiles/`) | Done |
| Share compile reports setting: off keeps every report on your machine with the local `theory/compiled` tag as the marker; upgrading carries the old tag over as a shared marker once | Done |
| Shared reports: the report dropdown and the compile history list your teammates' compiles from `.compiles/` with yours, newest first, with who compiled each; a report only in your data file is marked "Only on this machine", and a file that can't be read shows as "Can't read {file}". A shared report's Activity comes from its shared log | Done |
| Work on any shared report: build, recompile or open pull requests for a teammate's compile. theory.md pulls first, keeps every engineer's builds, and writes nothing when someone else changed the report and your vault can't fast-forward. When a teammate compiled the same revisions while you did, the report says so | Done |
| Compile lock within the app, so only one compile or build runs at a time | Done |
| Compile report view, with questions linking to the notes and a Reply button that opens the note at the rule that needs updating | Done |
| Suggest on each question: Claude, with no tools, offers text to copy and write into the note in your own words. Never saved, never written to a note | Done |
| Floating compile button showing pending revisions and compile state | Done |
| Read-only snapshot, deny rules and the post-compile check | Done |
| Failure overlay: highlights and a banner on the notes a failed compile points to | Done |
| Realized box and compile state in each note's header | Done |
| Comments: select text in a note and click the comment button, or run Comment on selection. Comments are signed with your git identity, saved in the model folder's `.comments/` and committed on their own, never sent to Claude. The Comments view in the right sidebar shows the threads on every note, grouped by note, with replies, resolve and reopen; clicking a quote opens the note at it; quoted text is underlined in the note | Done |
| Change dots in the file explorer: orange for uncommitted changes, the accent colour for committed changes waiting for a compile, on folders too | Done |
| Rule authors in the editor: grey text after each rule's first line saying who last changed it and when, or "Not committed yet" (Show rule authors setting) | Done |
| Rule count in each note's header: "12 rules", with each prefix's count and range in its tooltip, and the warning colour when an ID is declared twice | Done |
| Hidden folders: folders starting with `_` (like `_templates`) are grey and listed last in the file explorer. They are committed but never sent to Claude | Done |
| Build branches: `theory/{issue}-{short name}` for an issue, `theory/epic-{epic}-{short name}` for an epic, with `-2` when a name is taken | Done |
| Create PR: once an epic is built, open pull requests for its epic branches with `gh`, with a sparkle to write the body; the report, compile history and Repositories page show their state, refreshed when they open, on the compile history's Refresh and when Obsidian gets focus back | Done |
| Expand: on a model folder's `index.md`, Claude suggests which notes the model is missing. Create note makes an empty note you write yourself; never committed | Done |
| Repositories page: one card per repository with code, compile, model and remote KPIs; Add model folder. The command **New repository** creates a repository with its model folder | Done |
| Pull: the vault and the code repositories pull by themselves, fast-forward only, on launch, on focus, on a timer and before every compile; a sync status beside the commit button with a menu for when it last checked and pulled, and Pull now; the vault's remote set in the settings | Done |
| Model folders: one folder per repository with its own `index.md` and `instructions.md` (sent to Claude), shown in bold in the file explorer | Done |
| Model folder icon: in the file explorer, each folder named exactly like a repository in the project folder shows the history icon left of its name | Done |
| Hooks: your own shell commands run after a comment, a commit, a push, a compile or build starting or ending, or a permission request, with the event as JSON on stdin, like posting to Slack | Done |
| Server: team-wide marker and compile lock | Planned |

## Install

theory.md is desktop only and needs Obsidian 1.5.0 or later. It needs `git` on your machine, and Compile will also need the [Claude Code CLI](https://claude.com/claude-code). It isn't in Obsidian's Community plugins list yet, so install it one of these ways.

### With a coding agent

Paste this into Claude Code, Codex, Gemini CLI or any coding agent that can run shell commands, with your vault's path:

```
Install the theory.md Obsidian plugin into my vault at ~/path/to/vault.
Follow https://raw.githubusercontent.com/imtiazkun/theory-obsidian/main/INSTALL.md
```

Leave out the path and the agent lists your vaults and asks. It runs [`scripts/install.sh`](scripts/install.sh), which downloads the latest release, checks it against the release's checksums and turns the plugin on. On a first install it also takes your name and email from git, and asks the plugin to run **Setup vault** when it first loads. The agent asks before it restarts Obsidian. Obsidian may then ask you to trust the vault's plugins.

You can run the script yourself too:

```bash
curl -fsSL https://raw.githubusercontent.com/imtiazkun/theory-obsidian/main/scripts/install.sh | sh -s -- --vault ~/path/to/vault
```

Add `--project <folder>` to set the folder holding your code. Run it again to update.

### With BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins from GitHub releases and keeps them updated.

1. In Settings → Community plugins, turn off Restricted mode, then **Browse**, find **BRAT**, install it and enable it.
2. Run **BRAT: Add a beta plugin for testing** from the command palette.
3. Enter `imtiazkun/theory-obsidian` and click **Add Plugin**.
4. Turn on theory.md under Settings → Community plugins.

### By hand

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/imtiazkun/theory-obsidian/releases/latest).
2. Put them in `<vault>/.obsidian/plugins/theory-md/`, making the folder if it isn't there. `.obsidian` is hidden; in the macOS Finder, Cmd+Shift+. shows it.
3. Restart Obsidian, then turn on theory.md under Settings → Community plugins.

To update, replace the three files with the ones from a newer release.

## Disclosures

- **Network use.** theory.md makes no network requests itself and has no telemetry. It runs two command-line tools that do:
  - The [Claude Code CLI](https://claude.com/claude-code), for Compile, Suggest, Expand and the sparkle buttons that write commit messages and pull request bodies. These send Anthropic the model's text and diffs, and Compile also sends whatever Claude reads of each repository's default branch.
  - The [GitHub CLI](https://cli.github.com) (`gh`) and `git push`, for the issues a compile creates, Build's branches and pull requests, Create PR, pull request states and New repository.
- **Accounts.** The Claude features need Claude Code signed in to an Anthropic account, which is a paid service. The GitHub features, Compile and Build included, need `gh` signed in to GitHub with access to your GitHub Project (`gh auth refresh -s project`). Commits, history and the rest of the plugin work without either.
- **Files outside the vault.** theory.md reads and writes the project folder you pick in the settings: Compile only reads it, Build creates `theory/*` branches there, pushes them and Claude edits the code on them, and New repository creates a folder with a `README.md` and an `AGENTS.md`. Compile also copies the model into a temp folder (`$TMPDIR/theory-model-*`), and each repository's default branch as `origin` has it into another (`$TMPDIR/theory-code-*`), and deletes both afterwards. Claude reads the code only there, so a checkout on another branch, unpushed commits and uncommitted work never shape a compile, and the compile report lists the commit each repository was read at.
- **License.** theory.md is open source under the [GPL-3.0](LICENSE).

## Install for development

```bash
npm install
```

```bash
npm run build
```

Copy `manifest.json`, `styles.css` and `dist/main.js` into `<vault>/.obsidian/plugins/theory-md/`, then turn on theory.md under Settings → Community plugins. The plugin's ID, and so its folder, is `theory-md`.

Use `npm run dev` to rebuild on every change.

Run the tests with `npm test` (Vitest). Run one file or one test with `npm test -- test/build.test.ts -t "Retry"`.

## First use

If a coding agent or `scripts/install.sh` installed theory.md, steps 1 and 2 are already done, as long as git knows your name and email. That first load also turns off the core plugins theory.md doesn't use (turn any back on in Settings → Core plugins), sets the ribbon order and adds Graph view colour groups for templates, index files and instructions files. It never does this again; run **theory.md: Use theory.md's core plugins** to do it yourself, for example after installing by hand or with BRAT.

1. Make sure git knows your name and email: `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`. Settings → theory.md → Author shows what git signs with.
2. Run **theory.md: Setup vault** from the command palette.
3. In Settings → theory.md → Vault, click **Browse…** next to **Project folder** and pick the folder holding the code. It can be one repository, or a folder with several repositories side by side (a whole ecosystem). theory.md lists the git repositories it finds, or warns when there are none. Then, under Compile, add the commands Claude may run to **Allowed commands**, for example `Bash(npm run *)`.
4. Setup vault creates `Index.md` ("Manifesting <vault name>"), `Instructions.md` (the human-only rules and the doctrine), and the templates `_templates/index.md` and `_templates/instructions.md`, each unless the vault already has it. `Instructions.md` is for humans; Compile doesn't send it to Claude. When the new vault has Obsidian's `Welcome.md`, Setup replaces it with `_welcome.md`, which says where to start, and opens it. Delete it once read; notes whose name starts with `_` are never sent to Claude. Edit the templates to change how new model folders start. When a vault is missing any of these, the settings offer Create missing files.
5. Edit a note and click the commit button in its header.
6. Click **Compile** at the bottom right of the editor. The button shows how many revisions are waiting, and turns accent-coloured when there's something to compile. You can also run **theory.md: Compile** from the command palette. The compile report opens in a new tab.

### Compile settings

| Setting | What it does |
| --- | --- |
| Project folder (under Vault) | Folder the compiling agent works in. Settings lists the git repositories in it: the folder itself, or its immediate subfolders. The list is for your information only. |
| Agents and models | One row each for **Compile**, **Build**, **Expand** and **Writing** (commit messages, pull request bodies and Suggest). Each row names the agent it runs. A change applies from that task's next run; a running task keeps what it started with. After an upgrade, the old Agent, Model and Effort become Compile's row and every other row is *Same as Compile*, which follows Compile's row as it changes. |
| Agent | Compile and Build only. *Claude Code* (default) or *ACP agent*: any agent that speaks the Agent Client Protocol over stdio, like Gemini CLI, Codex or Claude Code through its ACP adapter. Build also offers *Same as Compile* (its default). Expand and Writing always use Claude Code. theory.md never installs an agent. |
| Agent command | Shown in a row set to *ACP agent*. The command that starts it, with its arguments, like `gemini --experimental-acp`. That task won't start while it's empty. An ACP agent decides by itself what to ask about: Always allow on its cards lasts for that run only, and writes to the model or outside the project folder are refused. |
| Agent model, Agent thinking level | Shown in a row set to *ACP agent* instead of Model and Effort. Text, empty by default: empty means the agent's default. When the task runs, each is matched against the choices the agent offers, by value or by name, and the activity log names the choice picked or says the agent uses its default. Stored apart from the row's Model and Effort, so switching agents loses neither. Settings never start the agent to read its list. |
| Claude Code command | `claude` by default, or an absolute path to the CLI. With *ACP agent* for both Compile and Build, used for Expand and Writing. |
| Model | Each row's Claude Code model: *Claude Code default*, *Fable*, *Opus*, *Sonnet* or *Haiku*, passed as `--model`, plus *Same as Compile* in every row but Compile's. The default passes nothing. |
| Effort | Each row's Claude Code effort: *Claude Code default*, *Low*, *Medium*, *High*, *Extra high* or *Max*, passed as `--effort`, plus *Same as Compile* in every row but Compile's. The default passes nothing. |
| Permission mode | Claude Code only, and only for Build, so hidden when Build's agent is an ACP agent: a compile only reads, so it gets the tools that read and nothing else. In a build, anything not allowed becomes a permission card in the compile report: **Allow**, **Always allow** (also adds the request's rules to Allowed commands, all shown on the card: every rule Claude Code suggests for a command, like `Bash(npm run:*)`, one per part of a compound command like `cd app && npm test`, else the exact command; that tool on that exact file for Edit, Write and NotebookEdit; Claude Code's suggestion or the tool's name for other tools) or **Deny**. A card nobody answers is denied after 120 seconds, and every denied step is listed in the report's problems. Writes to the model are denied without asking. *Edit files, run only allowed commands* is the default. *Auto* lets Claude decide what's safe. *Run anything* turns off checks. |
| Allowed commands | Claude Code only. Claude Code permission rules, separated by spaces. Defaults to `Bash(git *)`. Writes to the model are always denied, whatever this says. |
| Remote | The vault's `origin`, like `git@github.com:team/model.git`. When the vault has one, it is shown as plain text; change it with `git remote set-url origin <url>` in the vault. Without one, an empty field and Save add it, then pull. Save never replaces or removes a remote. It lives in the vault's git config, not the plugin's settings, and a password or token in the URL is refused. |
| Pull automatically | On by default. Pulls the vault's `main` from `origin` when Obsidian opens, when its window gets focus and every *Check every* minutes (1, 5, 15 or 30; 5 by default). Pulls only fast-forward, never touch a file with uncommitted changes and never ask for a password. **Pull now** and the pull before a compile run even when it's off. |
| Show rule authors | On by default. Grey text after each rule's first line in the editor: who last changed the rule and when, from git, or "Not committed yet". Display only; it is never written into the note or sent to an agent. Turning it off hides it at once in every open note. |
| GitHub Project | The URL of the GitHub Project every issue a compile creates is added to, like `https://github.com/orgs/team/projects/1`. Empty by default; Compile and Build don't start while it is empty. |
| Hooks | A list of shell commands, each tied to one event: `comment`, `commit`, `push`, `compile-start`, `compile-end`, `build-start`, `build-end` or `permission-request`. A hook runs after its event, in the vault folder with the login PATH, and gets the event as JSON on stdin: `event`, `vault`, `author`, `time` and `details` (the note and comment text, the commit hash and subject, the push status, the compile status, summary, number of questions and issues, the issues a build builds and how it ended, or the permission request). It never stops or delays what triggered it, is stopped after 10 seconds, and shows "Hook for {event} failed: {reason}" when it fails. **Test** sends it a sample event. Hooks live in the plugin's data, never in the vault, so they can hold secrets like a webhook URL. |
| Also pull code repositories | On by default. Each pull also fetches the project folder's repositories and fast-forwards those not on a compile branch, with no uncommitted changes and nothing of their own. |
| Share compile reports | On by default, whether or not the vault's repo is public. Each compile's report is committed and pushed in `.compiles/`, so teammates see why each issue exists and start from the same last compile. Off is for a public vault that describes private code: every report stays on your machine, and the last compile marker is the local tag `theory/compiled`, as before shared reports. Turning it off asks first: "Teammates won't see your compiles, and may compile the same revisions again. Turn off?" |

## Compile rules

- **What gets compiled.** Only committed revisions. Uncommitted edits are left out, and theory.md says how many when you click Compile.
- **Last compile marker.** theory.md records the last compile in two places. In the vault repo, each compile Claude ran gets a shared report in the `.compiles/` dot folder (`{UTC start}-{short id}.json`, plus its Activity log), committed and pushed by itself, so nothing is written into the notes. The marker is the newest revision such a committed report moved it to, so every engineer gets the same marker with the next pull. When the commit or push fails, the notice says "Compile report saved but not shared: {reason}" and the next commit of that report carries it. Any engineer may build from, recompile or open pull requests for any shared report. Before writing to it, theory.md pulls the vault; when that report changed on the remote and the vault can't fast-forward, it writes nothing and says "Someone else changed this compile. Pull with rebase in git, then try again." When two engineers compile the same revisions at once, the one whose report can't be pushed sees "Someone else compiled these revisions while you did. Check both reports before you build." With **Share compile reports** off, nothing goes to `.compiles/`, and the marker is the local tag `theory/compiled`. **Upgrading:** on the first load with shared reports, the old `theory/compiled` tag is carried over as a marker-only report ("Imported", "Marker carried over from {you}'s machine"), committed as "Share the compile marker", unless a shared report moved the marker already; your earlier reports stay in your data file, marked "Only on this machine", and the tag stays where it was. In the code repositories, every commit a build makes names the vault commit it was built from and the issue it builds.
- **Compile plans, Build writes the code.** A compile never changes a code repository. Claude reads the model and the code and plans one issue, or an epic with sub-issues in build order, each in one repository with the rule IDs it covers. theory.md creates them with `gh`, adds them to the GitHub Project, and when that fails asks Retry or Discard (Discard closes them as not planned and the marker stays). Compile needs `gh` signed in, a GitHub `origin` in every repository, the GitHub Project set, and no uncommitted changes.
- **Build.** Click Build in the report, or run the command Build. One issue gets `theory/{number}-{short name}` from the default branch, and a pull request into the default branch that closes it. An epic gets `theory/epic-{number}-{short name}` in every repository with a sub-issue; each sub-issue is built on its own branch from it, merged into it with a pull request, and closed. You merge the result into the default branch; theory.md never does, never pushes with force and never moves the marker. A build refuses to start while a repository has uncommitted changes, its default branch and upstream both have new commits, or an earlier build's pull request or epic branch is still open.
- **One compile or build at a time.** While one runs, clicking Compile or Build again only tells you one is already running. For now the lock lives inside the app. With a server it will move to the shared remote, so a second engineer waits too.
- **Failures.** The marker moves forward even when a compile fails. It doesn't move when you cancel, or when Compile can't start (no project folder, CLI not found). The failure is logged in the compile report, and the next compile only takes revisions committed after it. Re-applying a failed revision is a human decision.
- **Questions back from Claude.** When the model is unclear or contradicts itself, Claude lists its questions in a compile report that theory.md shows in Obsidian. Each question links to the notes it refers to, and its **Reply** button opens the note at the rule that needs updating, else at its heading, else at the top of the note. Reports are kept in the plugin's own data file (`.obsidian/plugins/theory-md/data.json`, which git ignores), not in the model, so the model stays human-only. The last 20 are kept. Engineers answer by editing the model and compiling again.
- **Realized notes.** Every note's header has a check box. Untick it when a note is written ahead of the code, and Claude leaves that note alone. It's stored as `realized: false` in the note's properties, which theory.md hides from view. A ticked box writes nothing, so most notes stay clean. Next to it, a second icon shows what compiles have done with the note: not committed, waiting for a compile, compiling, failed or compiled. Clicking it opens the compile report.
- **Where a compile failed.** Claude can point each problem at a note, a heading and a short quote. theory.md checks every pointer against the compiled revision and drops any that don't match. It then highlights the spot in the note and adds a banner above it, with a link to the report. If Claude points at nothing, the banner goes on the notes that changed in the failed compile. This only changes what Obsidian shows; the notes themselves are never written. Dismiss clears it, and so does the next successful compile.
