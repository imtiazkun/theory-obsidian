import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

export const AUTHOR = { fullName: "Test Author", email: "test@example.com" };

const made: string[] = [];

/** A new temporary folder, deleted after the test. Tests never touch the vault or real repositories (TEST-5). */
export function tempDir(prefix = "theory-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of made.splice(0)) {
		execFileSync("chmod", ["-R", "u+w", dir]);
		rmSync(dir, { recursive: true, force: true });
	}
});

export function sh(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", `user.name=${AUTHOR.fullName}`, "-c", `user.email=${AUTHOR.email}`, ...args], {
		cwd,
		encoding: "utf8",
	}).trim();
}

export function write(base: string, path: string, text: string) {
	mkdirSync(dirname(join(base, path)), { recursive: true });
	writeFileSync(join(base, path), text);
}

/** A git repository on `main` with the files committed. */
export function repo(dir: string, files: Record<string, string> = { "README.md": "hello\n" }): string {
	mkdirSync(dir, { recursive: true });
	sh(dir, ["init", "-q", "-b", "main"]);
	for (const [path, text] of Object.entries(files)) write(dir, path, text);
	sh(dir, ["add", "-A"]);
	sh(dir, ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
	return dir;
}

export function commitFile(dir: string, path: string, text: string, message = `Update ${path}`) {
	write(dir, path, text);
	sh(dir, ["add", "--", path]);
	sh(dir, ["commit", "-q", "-m", message]);
}
