# theory.md

theory.md is an Obsidian plugin for keeping a **theoretical model** of the software a team builds. Only humans write the model. The AI reads it and changes the code to match.

## Why

Margaret-Anne Storey's post [How Generative and Agentic AI Shift Concern from Technical Debt to Cognitive Debt](https://margaretstorey.com/blog/2026/02/09/cognitive-debt/) (Feb 2026) argues that when AI writes the code, the bigger risk is no longer messy code. The bigger risk is **cognitive debt**: the team stops understanding what the system does and why. Her short version: "Technical debt lives in the code; cognitive debt lives in developers' minds."

The post builds on Peter Naur's *Programming as Theory Building*. Naur says a program is really a theory held in its developers' heads, and the code is only a by-product of that theory. When agents write the code and nobody holds the theory, the system turns into a black box.

theory.md keeps the theory on the page. Engineers write down what the software is, how it behaves and why. Claude builds the code from that, so the people who understand the system stay the source of truth.

## The theoretical model

The theoretical model is an Obsidian vault that describes the product:

- It is mostly Markdown text, with SVG and image assets for diagrams.
- It says *what* the system does and *why*: concepts, behaviour, rules, decisions.
- It lives in **its own git repository**, separate from the code it describes.
- `Index.md` at the vault root is the entry point. theory.md opens it on launch.
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

theory.md currently runs **locally for a single user**: one engineer, one vault and one project folder on the same machine. A server for team sync comes later.

| Feature | Status |
| --- | --- |
| Setup vault: turns the vault into a git repo with a `.gitignore`, a starter `Index.md` and `Instructions.md`, the templates in `_templates/`, and an initial commit | Done |
| Create missing files: a vault set up by an older version, or missing a starter file, gets only the missing files and `.gitignore` lines from the settings, committed on their own | Done |
| Templates: a new model folder's `index.md` and `instructions.md` start from `_templates/index.md` and `_templates/instructions.md`, with `{{name}}`, `{{description}}` and `{{purpose}}` filled in | Done |
| Author settings: full name and email used to sign commits | Done |
| Commit button in each note's header, marked when the note has changes | Done |
| Commit modal: message, with an option to include all changed files | Done |
| Generate the commit message with Claude (sparkle button in the commit modal) | Done |
| Commit history view in the right sidebar | Done |
| Compile history view in the right sidebar: when, who and tokens spent | Done |
| Open `Index.md` on launch | Done |
| Compile: send revisions since the last compile to Claude Code | Done |
| Last compile marker (local `theory/compiled` tag) | Done |
| Compile lock within the app, so only one compile runs at a time | Done |
| Compile report view, with questions linking to the notes and a Reply button that opens the note at the rule that needs updating | Done |
| Suggest on each question: Claude, with no tools, offers text to copy and write into the note in your own words. Never saved, never written to a note | Done |
| Floating compile button showing pending revisions and compile state | Done |
| Read-only snapshot, deny rules and the post-compile check | Done |
| Failure overlay: highlights and a banner on the notes a failed compile points to | Done |
| Realized box and compile state in each note's header | Done |
| Hidden folders: folders starting with `_` (like `_templates`) are grey and listed last in the file explorer. They are committed but never sent to Claude | Done |
| Compile branches: every compile commits on `theory/compile-{revision}`, at most one open per repository; empty ones are deleted | Done |
| Create PR: push the compile branches and open pull requests with `gh`, with a sparkle to write the body; the report, compile history and Repositories page show their state, refreshed when they open, on the compile history's Refresh and when Obsidian gets focus back | Done |
| Expand: on a model folder's `index.md`, Claude suggests which notes the model is missing. Create note makes an empty note you write yourself; never committed | Done |
| Repositories page: one card per repository with code, compile, model and remote KPIs; Add model folder; New repository | Done |
| Model folders: one folder per repository with its own `index.md` and `instructions.md` (sent to Claude), shown in bold in the file explorer | Done |
| Server: shared remote, team-wide marker and lock | Planned |

## Install for development

theory.md is desktop only. It needs `git` on your machine, and Compile will also need the [Claude Code CLI](https://claude.com/claude-code).

```bash
npm install
```

```bash
npm run build
```

Copy `manifest.json`, `styles.css` and `dist/main.js` into `<vault>/.obsidian/plugins/theory-md/`, then turn on theory.md under Settings → Community plugins. The plugin's ID, and so its folder, is `theory-md`.

Use `npm run dev` to rebuild on every change.

Run the tests with `npm test` (Vitest). Run one file or one test with `npm test -- test/branches.test.ts -t "reuses"`.

## First use

1. Open Settings → theory.md and enter your full name and email.
2. Run **theory.md: Setup vault** from the command palette.
3. In Settings → theory.md → Vault, click **Browse…** next to **Project folder** and pick the folder holding the code. It can be one repository, or a folder with several repositories side by side (a whole ecosystem). theory.md lists the git repositories it finds, or warns when there are none. Then, under Compile, add the commands Claude may run to **Allowed commands**, for example `Bash(npm run *)`.
4. Setup vault creates `Index.md` ("Manifesting <vault name>"), `Instructions.md` (the human-only rules and the doctrine), and the templates `_templates/index.md` and `_templates/instructions.md`, each unless the vault already has it. `Instructions.md` is for humans; Compile doesn't send it to Claude. Edit the templates to change how new model folders start. When a vault is missing any of these, the settings offer Create missing files.
5. Edit a note and click the commit button in its header.
6. Click **Compile** at the bottom right of the editor. The button shows how many revisions are waiting, and turns accent-coloured when there's something to compile. You can also use the hammer in the ribbon or **theory.md: Compile** in the command palette. The compile report opens in a new tab.

### Compile settings

| Setting | What it does |
| --- | --- |
| Project folder (under Vault) | Folder Claude works in. Compile always runs Claude Code here. Settings lists the git repositories in it: the folder itself, or its immediate subfolders. The list is for your information only. |
| Claude Code command | `claude` by default, or an absolute path to the CLI. |
| Model | *Claude Code default*, *Fable*, *Opus*, *Sonnet* or *Haiku*, passed to Claude Code as `--model`. The default passes nothing. Applies from the next compile. |
| Effort | *Claude Code default*, *Low*, *Medium*, *High*, *Extra high* or *Max*, passed to Claude Code as `--effort`. The default passes nothing. Applies from the next compile. |
| Permission mode | Anything not allowed becomes a permission card in the compile report: **Allow**, **Always allow** (also adds the request's rules to Allowed commands, all shown on the card: every rule Claude Code suggests for a command, like `Bash(npm run:*)`, one per part of a compound command like `cd app && npm test`, else the exact command; that tool on that exact file for Edit, Write and NotebookEdit; Claude Code's suggestion or the tool's name for other tools) or **Deny**. A card nobody answers is denied after 120 seconds, and every denied step is listed in the report's problems. Writes to the model are denied without asking. *Edit files, run only allowed commands* is the default. *Auto* lets Claude decide what's safe. *Run anything* turns off checks. |
| Allowed commands | Claude Code permission rules, separated by spaces. Defaults to `Bash(git *)`. Writes to the model are always denied, whatever this says. |

## Compile rules

- **What gets compiled.** Only committed revisions. Uncommitted edits are left out, and theory.md says how many when you click Compile.
- **Last compile marker.** theory.md records the last compile in two places. In the vault repo, it moves the `theory/compiled` git tag to the compiled commit, so nothing is written into the notes. Once there is a server, the tag will be pushed so every engineer sees the same marker. In the code repositories, the commit message of each compile names the vault commit it was built from.
- **Compile branches.** Before Claude runs, theory.md checks out a compile branch in every repository: the open one, or a new `theory/compile-{revision}` from the branch you're on. Claude commits there. A new branch that got no commits is deleted afterwards. Compile refuses to start while a repository has uncommitted changes, and it never pushes: **Create PR** in the report does.
- **One compile at a time.** While a compile runs, clicking Compile again only tells you one is already running. For now the lock lives inside the app. With a server it will move to the shared remote, so a second engineer waits too.
- **Failures.** The marker moves forward even when a compile fails. It doesn't move when you cancel, or when Compile can't start (no project folder, CLI not found). The failure is logged in the compile report, and the next compile only takes revisions committed after it. Re-applying a failed revision is a human decision.
- **Questions back from Claude.** When the model is unclear or contradicts itself, Claude lists its questions in a compile report that theory.md shows in Obsidian. Each question links to the notes it refers to, and its **Reply** button opens the note at the rule that needs updating, else at its heading, else at the top of the note. Reports are kept in the plugin's own data file (`.obsidian/plugins/theory-md/data.json`, which git ignores), not in the model, so the model stays human-only. The last 20 are kept. Engineers answer by editing the model and compiling again.
- **Realized notes.** Every note's header has a check box. Untick it when a note is written ahead of the code, and Claude leaves that note alone. It's stored as `realized: false` in the note's properties, which theory.md hides from view. A ticked box writes nothing, so most notes stay clean. Next to it, a second icon shows what compiles have done with the note: not committed, waiting for a compile, compiling, failed or compiled. Clicking it opens the compile report.
- **Where a compile failed.** Claude can point each problem at a note, a heading and a short quote. theory.md checks every pointer against the compiled revision and drops any that don't match. It then highlights the spot in the note and adds a banner above it, with a link to the report. If Claude points at nothing, the banner goes on the notes that changed in the failed compile. This only changes what Obsidian shows; the notes themselves are never written. Dismiss clears it, and so does the next successful compile.
