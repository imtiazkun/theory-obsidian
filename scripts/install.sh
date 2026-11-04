#!/bin/sh
# Installs theory.md into an Obsidian vault, or updates it there. Written for coding agents to run
# (see INSTALL.md), and safe for people to run too. It only writes inside
# <vault>/.obsidian/: the plugin's folder and community-plugins.json. It never touches notes.
#
#   install.sh --list-vaults
#   install.sh --vault <path> [--project <folder>] [--version <tag>] [--from <folder>]
#
# --project   the folder holding the code, saved as the Project folder on a first install
# --version   a release tag like 0.1.2, instead of the latest release
# --from      a folder holding main.js, manifest.json and styles.css (like dist/), instead of a download

set -eu

REPO="imtiazkun/theory-obsidian"
PLUGIN_ID="theory-md"
FILES="main.js manifest.json styles.css"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$*" >&2; }

usage() {
	cat << 'EOF'
  install.sh --list-vaults
  install.sh --vault <path> [--project <folder>] [--version <tag>] [--from <folder>]

--project   the folder holding the code, saved as the Project folder on a first install
--version   a release tag like 0.1.2, instead of the latest release
--from      a folder holding main.js, manifest.json and styles.css (like dist/), instead of a download
EOF
	exit "${1:-0}"
}

# Obsidian's list of known vaults, one per platform and package.
vault_registries() {
	printf '%s\n' \
		"$HOME/Library/Application Support/obsidian/obsidian.json" \
		"${XDG_CONFIG_HOME:-$HOME/.config}/obsidian/obsidian.json" \
		"$HOME/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json" \
		"$HOME/snap/obsidian/current/.config/obsidian/obsidian.json"
}

list_vaults() {
	vault_registries | while IFS= read -r registry; do
		[ -f "$registry" ] || continue
		grep -o '"path":"[^"]*"' "$registry" | sed 's/^"path":"//; s/"$//; s/\\\\/\\/g'
	done | sort -u > "$tmp/vaults"
	if [ -s "$tmp/vaults" ]; then
		cat "$tmp/vaults"
	else
		warn "found no vaults Obsidian knows about. Open the vault in Obsidian once, or pass its path."
	fi
}

# A JSON string holding $1.
json_string() {
	printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

sha256_check() {
	if command -v sha256sum > /dev/null 2>&1; then
		(cd "$1" && sha256sum -c --quiet checksums.txt)
	elif command -v shasum > /dev/null 2>&1; then
		(cd "$1" && shasum -a 256 -c --quiet checksums.txt)
	else
		fail "can't check the download: neither sha256sum nor shasum is installed"
	fi
}

download() {
	if [ -n "$version" ]; then
		base="https://github.com/$REPO/releases/download/$version"
	else
		base="https://github.com/$REPO/releases/latest/download"
	fi
	command -v curl > /dev/null 2>&1 || fail "curl is needed to download theory.md"
	for file in $FILES; do
		curl -fsSL -o "$tmp/$file" "$base/$file" || fail "couldn't download $file from $base"
	done
	# Releases before 0.1.2 have no checksums.
	if curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt" 2> /dev/null; then
		sha256_check "$tmp" || fail "the downloaded files don't match the release's checksums.txt"
		checked="yes"
	else
		rm -f "$tmp/checksums.txt"
		warn "this release has no checksums.txt, so the download wasn't checked"
	fi
}

# Adds the plugin to community-plugins.json, keeping every other entry.
enable_plugin() {
	list="$1/community-plugins.json"
	if [ ! -s "$list" ]; then
		printf '[\n  "%s"\n]\n' "$PLUGIN_ID" > "$list"
		return
	fi
	if grep -q "\"$PLUGIN_ID\"" "$list"; then
		enabled="already"
		return
	fi
	body=$(cat "$list")
	# Trim the whitespace around the array, then take off its closing bracket.
	while :; do case "$body" in [[:space:]]*) body=${body#?} ;; *) break ;; esac; done
	while :; do case "$body" in *[[:space:]]) body=${body%?} ;; *) break ;; esac; done
	case "$body" in
		\[*\]) ;;
		*) fail "$list isn't a JSON list. Add \"$PLUGIN_ID\" to it by hand, or delete it." ;;
	esac
	body=${body%?}
	while :; do case "$body" in *[[:space:]]) body=${body%?} ;; *) break ;; esac; done
	if [ "$body" = "[" ]; then
		printf '[\n  "%s"\n]\n' "$PLUGIN_ID" > "$list"
	else
		printf '%s,\n  "%s"\n]\n' "$body" "$PLUGIN_ID" > "$list"
	fi
}

# First install only: the author from git, the project folder, and a request to set up the vault
# when the plugin first loads. An existing data.json holds the engineer's settings and reports, so
# it's never changed.
seed_settings() {
	data="$1/data.json"
	if [ -e "$data" ]; then
		settings="kept"
		[ -z "$project" ] || warn "kept the existing settings, so --project wasn't saved. Set it in Settings → theory.md."
		return
	fi
	name=$(git config --get user.name 2> /dev/null || true)
	email=$(git config --get user.email 2> /dev/null || true)
	{
		printf '{\n'
		printf '  "fullName": %s,\n' "$(json_string "$name")"
		printf '  "email": %s,\n' "$(json_string "$email")"
		[ -z "$project" ] || printf '  "projectFolder": %s,\n' "$(json_string "$project")"
		printf '  "setupOnLoad": true\n'
		printf '}\n'
	} > "$data"
	settings="new"
	[ -n "$name" ] && [ -n "$email" ] || warn "git has no user.name or user.email. Enter them in Settings → theory.md, then run theory.md: Setup vault."
}

obsidian_running() {
	pgrep -x Obsidian > /dev/null 2>&1 || pgrep -x obsidian > /dev/null 2>&1
}

vault=""
project=""
version=""
from=""
listing=""
while [ $# -gt 0 ]; do
	case "$1" in
		--vault) [ $# -ge 2 ] || usage 2; vault="$2"; shift 2 ;;
		--project) [ $# -ge 2 ] || usage 2; project="$2"; shift 2 ;;
		--version) [ $# -ge 2 ] || usage 2; version="$2"; shift 2 ;;
		--from) [ $# -ge 2 ] || usage 2; from="$2"; shift 2 ;;
		--list-vaults) listing="yes"; shift ;;
		-h | --help) usage 0 ;;
		*) warn "unknown option: $1"; usage 2 ;;
	esac
done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/theory-install-XXXXXX")
trap 'rm -rf "$tmp"' EXIT

if [ -n "$listing" ]; then
	list_vaults
	exit 0
fi

[ -n "$vault" ] || usage 2
[ -d "$vault" ] || fail "no folder at $vault"
vault=$(cd "$vault" && pwd -P)
[ -d "$vault/.obsidian" ] || fail "$vault isn't an Obsidian vault yet: it has no .obsidian folder. Open it in Obsidian once (Open folder as vault), then run this again."
if [ -n "$project" ]; then
	[ -d "$project" ] || fail "no folder at $project"
	project=$(cd "$project" && pwd -P)
fi

command -v git > /dev/null 2>&1 || fail "theory.md needs git. On macOS run: xcode-select --install"
command -v claude > /dev/null 2>&1 || warn "the Claude Code CLI isn't on PATH. Install it before you compile: https://claude.com/claude-code"

checked="no"
if [ -n "$from" ]; then
	for file in $FILES; do
		[ -f "$from/$file" ] || fail "$from has no $file"
		cp "$from/$file" "$tmp/$file"
	done
	if [ -f "$from/checksums.txt" ]; then
		cp "$from/checksums.txt" "$tmp/checksums.txt"
		sha256_check "$tmp" || fail "the files in $from don't match its checksums.txt"
		checked="yes"
	fi
else
	download
fi

grep -q "\"id\": *\"$PLUGIN_ID\"" "$tmp/manifest.json" || fail "the downloaded manifest.json isn't theory.md's"
new_version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$tmp/manifest.json" | head -n 1)

plugin_dir="$vault/.obsidian/plugins/$PLUGIN_ID"
old_version=""
[ -f "$plugin_dir/manifest.json" ] && old_version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$plugin_dir/manifest.json" | head -n 1)
mkdir -p "$plugin_dir"
for file in $FILES; do
	cp "$tmp/$file" "$plugin_dir/$file"
done

enabled="yes"
enable_plugin "$vault/.obsidian"
seed_settings "$plugin_dir"

running="no"
obsidian_running && running="yes"

say "theory.md $new_version installed"
say "vault: $vault"
say "plugin folder: $plugin_dir"
say "previous version: ${old_version:-none}"
say "checksums checked: $checked"
say "enabled in community-plugins.json: $enabled"
say "settings: $settings"
say "obsidian running: $running"
if [ "$running" = "yes" ]; then
	say "next: quit and reopen Obsidian so it loads the plugin"
else
	say "next: open the vault in Obsidian"
fi
