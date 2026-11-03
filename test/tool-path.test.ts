import { chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { LOGIN_SHELL_TIMEOUT_MS, loginShell, readLoginPath, resolveToolPath, withExtraFolders } from "../src/tool-path";
import { tempFolder } from "./helpers";

const EXTRA = "/usr/bin:/usr/local/bin:/opt/homebrew/bin";

/** A fake shell in a temp folder that runs `body` with its arguments. */
function fakeShell(body: string): string {
	const path = join(tempFolder(), "shell");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** A shell whose startup files print noise and set PATH, then runs the plugin's command (`-ilc <command>`). */
function loginShellWithPath(path: string): string {
	return fakeShell(`echo "Welcome back"\nPATH=${path}\nexport PATH\n[ "$1" = "-ilc" ] || exit 2\nexec /bin/sh -c "$2"`);
}

describe("login PATH", () => {
	it("uses the PATH the login shell prints, ignoring what its startup files print", async () => {
		const shell = loginShellWithPath("/Users/me/.docker/bin:/bin:/usr/bin");
		expect(await readLoginPath(shell)).toBe("/Users/me/.docker/bin:/bin:/usr/bin");
		expect(await resolveToolPath(shell, LOGIN_SHELL_TIMEOUT_MS, "/obsidian/bin")).toBe(
			withExtraFolders("/Users/me/.docker/bin:/bin:/usr/bin"),
		);
	});

	it("adds the extra folders after the login PATH", () => {
		expect(withExtraFolders("/a:/b", "/Users/me")).toBe(`/a:/b:${EXTRA}:/Users/me/.local/bin`);
		expect(withExtraFolders("/a", "")).toBe(`/a:${EXTRA}`);
	});

	it("falls back to Obsidian's own PATH when the shell fails", async () => {
		const failing = fakeShell("exit 1");
		expect(await readLoginPath(failing)).toBeUndefined();
		expect(await resolveToolPath(failing, LOGIN_SHELL_TIMEOUT_MS, "/obsidian/bin")).toBe(withExtraFolders("/obsidian/bin"));
	});

	it("falls back when the shell doesn't exist or prints no PATH", async () => {
		const missing = join(tempFolder(), "no-such-shell");
		expect(await resolveToolPath(missing, LOGIN_SHELL_TIMEOUT_MS, "/obsidian/bin")).toBe(withExtraFolders("/obsidian/bin"));
		expect(await readLoginPath(fakeShell("echo hello"))).toBeUndefined();
	});

	it("waits at most 5 seconds, then falls back", async () => {
		expect(LOGIN_SHELL_TIMEOUT_MS).toBe(5000);
		const hanging = fakeShell("exec sleep 30");
		const started = Date.now();
		expect(await resolveToolPath(hanging, 200, "/obsidian/bin")).toBe(withExtraFolders("/obsidian/bin"));
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("runs the shell in $SHELL, or /bin/zsh when it isn't set", () => {
		expect(loginShell({ SHELL: "/usr/local/bin/fish" })).toBe("/usr/local/bin/fish");
		expect(loginShell({})).toBe("/bin/zsh");
	});
});
