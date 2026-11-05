# Installing theory.md: steps for coding agents

You are a coding agent (Claude Code, Codex, Gemini CLI or similar) and a person asked you to install theory.md, an Obsidian plugin, into one of their vaults. Follow these steps in order. People can read this too, but the [README](README.md#install) is written for them.

## Rules

- Only `scripts/install.sh` writes anything, and only inside `<vault>/.obsidian/`. Don't edit, create or delete notes in the vault, don't run git in it, and don't touch other plugins' folders.
- theory.md's model is written by humans only. Don't set up the vault yourself, write `Index.md` or make the first commit. The plugin does that when it first loads, signed with the person's name.
- Ask before quitting Obsidian.
- Don't sign the person in to anything (Claude Code, GitHub). Say what's missing and let them do it.

## 1. Find the vault

If the person gave a path, use it. Otherwise list the vaults Obsidian knows about and ask which one:

```bash
curl -fsSL https://raw.githubusercontent.com/imtiazkun/theory-obsidian/main/scripts/install.sh -o "${TMPDIR:-/tmp}/theory-install.sh"
sh "${TMPDIR:-/tmp}/theory-install.sh" --list-vaults
```

The vault must already be open in Obsidian at least once, so it has a `.obsidian` folder. If the person has no vault yet, ask them to make one in Obsidian (**Create new vault**, or **Open folder as vault**), then go on.

Ask whether they want to give the folder that holds their code (the **Project folder**, which Compile works in). It's optional; they can set it in the plugin's settings later.

## 2. Read the script, then run it

Download `scripts/install.sh` (see step 1) and read it before you run it. Then:

```bash
sh "${TMPDIR:-/tmp}/theory-install.sh" --vault "<vault path>" --project "<code folder>"
```

Leave out `--project` if they didn't give one. Use `--version <tag>` only if they asked for a particular release.

The script:

1. Downloads `main.js`, `manifest.json` and `styles.css` from the latest GitHub release and checks them against the release's `checksums.txt`.
2. Copies them into `<vault>/.obsidian/plugins/theory-md/`. Running it again updates the plugin in place.
3. Adds `theory-md` to `<vault>/.obsidian/community-plugins.json`, keeping every other entry.
4. On a first install only, writes the plugin's settings: name and email from `git config`, the project folder, and a one-time request to run **Setup vault** when the plugin first loads. Existing settings are never changed.

It ends with `key: value` lines (version, checksums checked, settings, whether Obsidian is running). If it fails, show the person its error and stop. Don't work around it by copying files yourself.

## 3. Restart Obsidian

Obsidian only loads a new plugin when it starts. If the script says `obsidian running: yes`, ask the person whether you may quit Obsidian. On a yes:

```bash
osascript -e 'quit app "Obsidian"'   # macOS
```

On Linux, ask them to quit it themselves. Then open the vault:

```bash
open "obsidian://open?path=<url-encoded vault path>"       # macOS
xdg-open "obsidian://open?path=<url-encoded vault path>"   # Linux
```

## 4. Tell the person what's left

Say which version was installed, into which vault, and that these steps are theirs:

- **Trust the plugin.** If Obsidian asks whether to trust the vault's plugins, or Community plugins is in Restricted mode, they turn that off. theory.md then loads.
- **Setup vault runs by itself** on that first load: it makes the vault a git repository with `Index.md`, `Instructions.md`, `_templates/` and a first commit signed with their name. A vault that already uses git is left as it is.
- **Name and email.** If the script warned that git has no `user.name` or `user.email`, they set them with `git config --global user.name "Their Name"` and `git config --global user.email "them@example.com"`, then run **theory.md: Setup vault** from the command palette. theory.md signs commits with the name and email git uses.
- **Claude Code.** Compile needs the [Claude Code CLI](https://claude.com/claude-code), signed in. If the script warned that it isn't on PATH, say so. **Create PR** also needs the [GitHub CLI](https://cli.github.com) signed in (`gh auth status`).
- **Allowed commands.** Under Settings → theory.md → Compile, they add the commands Claude may run in their project, like `Bash(npm run *)`.

## Updating

Run step 2 again on the same vault, then restart Obsidian. Settings and compile reports are kept.

## Windows

`install.sh` needs a POSIX shell. On Windows, use Git Bash or WSL, or follow the by-hand steps in the [README](README.md#install).
