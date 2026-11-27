import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach } from "vitest";
import { git } from "../src/vault";

const folders: string[] = [];

/** A new empty folder under the system temp folder, deleted after the test. */
export function tempFolder(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "theory-test-")));
	folders.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); // A git process may still be finishing.
});

/** Writes `files` (path relative to `root` → text), creating folders as needed. */
export function write(root: string, files: Record<string, string>) {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
}

/** A git repository on `main` at `path`, with one commit holding `files`. */
export async function initRepo(path: string, files: Record<string, string> = { "README.md": "readme\n" }) {
	mkdirSync(path, { recursive: true });
	await git(path, ["init", "-b", "main"]);
	write(path, files);
	await git(path, ["add", "-A"]);
	await git(path, ["commit", "-m", "Initial commit"]);
}

/** Writes `files` and commits them all with `message`. Returns the new commit's hash. */
export async function commitFiles(repo: string, files: Record<string, string>, message: string): Promise<string> {
	write(repo, files);
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-m", message]);
	return out(repo, ["rev-parse", "HEAD"]);
}

/** Git's output, trimmed. */
export async function out(repo: string, args: string[]): Promise<string> {
	return (await git(repo, args)).stdout.trim();
}

/**
 * Commits a shared report in `.compiles/` that moves the last compile marker to `to` (REP-49), as a compile that
 * Claude ran would. Returns the new commit's hash.
 */
export async function markCompiled(vault: string, to: string, from: string | null = null, name = "2026-01-01T00-00-00Z-marker"): Promise<string> {
	const report = { version: 1, id: name.slice(-6), from, to, markerMoved: true, status: "succeeded" };
	return commitFiles(vault, { [`.compiles/${name}.json`]: JSON.stringify(report, null, 2) + "\n" }, `Compile ${to.slice(0, 7)}`);
}
