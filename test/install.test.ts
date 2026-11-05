import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { tempFolder, write } from "./helpers";

const SCRIPT = join(__dirname, "..", "scripts", "install.sh");
const MANIFEST = '{\n\t"id": "theory-md",\n\t"name": "theory.md",\n\t"version": "9.9.9"\n}\n';

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

async function install(args: string[], env: Record<string, string> = {}): Promise<Result> {
	try {
		const { stdout, stderr } = await promisify(execFile)("sh", [SCRIPT, ...args], { env: { ...process.env, ...env } });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
	}
}

/** A folder like dist/, holding the three plugin files. */
function release(): string {
	const dir = tempFolder();
	write(dir, { "main.js": "// main\n", "manifest.json": MANIFEST, "styles.css": "/* styles */\n" });
	return dir;
}

/** An empty vault that Obsidian has opened once, plus `files` in it. */
function vault(files: Record<string, string> = {}): string {
	const dir = tempFolder();
	mkdirSync(join(dir, ".obsidian"));
	write(dir, files);
	return dir;
}

const pluginDir = (vault: string) => join(vault, ".obsidian", "plugins", "theory-md");
const enabled = (vault: string) => JSON.parse(readFileSync(join(vault, ".obsidian", "community-plugins.json"), "utf8"));
const data = (vault: string) => JSON.parse(readFileSync(join(pluginDir(vault), "data.json"), "utf8"));

describe("install.sh", () => {
	it("installs into a fresh vault, turns the plugin on and asks for Setup vault on the first load", async () => {
		const from = release();
		const target = vault();
		const project = tempFolder();
		const result = await install(["--vault", target, "--project", project, "--from", from]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("theory.md 9.9.9 installed");
		expect(result.stdout).toContain("settings: new");
		for (const file of ["main.js", "manifest.json", "styles.css"]) {
			expect(readFileSync(join(pluginDir(target), file), "utf8")).toBe(readFileSync(join(from, file), "utf8"));
		}
		expect(enabled(target)).toEqual(["theory-md"]);
		// No author is saved: commits are signed with the name and email git uses (CFG-34).
		expect(data(target)).toEqual({ projectFolder: project, setupOnLoad: true });
		// Notes and git are the plugin's business, never the script's.
		expect(existsSync(join(target, ".git"))).toBe(false);
		expect(existsSync(join(target, "Index.md"))).toBe(false);
	});

	it("keeps the other plugins and never lists theory.md twice", async () => {
		const from = release();
		const target = vault({ ".obsidian/community-plugins.json": '[\n  "dataview",\n  "obsidian-git"\n]' });

		expect((await install(["--vault", target, "--from", from])).code).toBe(0);
		expect(enabled(target)).toEqual(["dataview", "obsidian-git", "theory-md"]);
		const again = await install(["--vault", target, "--from", from]);
		expect(again.stdout).toContain("enabled in community-plugins.json: already");
		expect(enabled(target)).toEqual(["dataview", "obsidian-git", "theory-md"]);
	});

	it("turns the plugin on in an empty list", async () => {
		const target = vault({ ".obsidian/community-plugins.json": "[]\n" });
		expect((await install(["--vault", target, "--from", release()])).code).toBe(0);
		expect(enabled(target)).toEqual(["theory-md"]);
	});

	it("updates the files but keeps existing settings and reports", async () => {
		const settings = '{"fullName":"Ada","email":"ada@example.com","reports":[{"id":"r1"}]}';
		const target = vault({
			".obsidian/plugins/theory-md/data.json": settings,
			".obsidian/plugins/theory-md/manifest.json": MANIFEST.replace("9.9.9", "0.1.1"),
		});
		const result = await install(["--vault", target, "--project", tempFolder(), "--from", release()]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("previous version: 0.1.1");
		expect(result.stdout).toContain("settings: kept");
		expect(result.stderr).toContain("--project wasn't saved");
		expect(readFileSync(join(pluginDir(target), "data.json"), "utf8")).toBe(settings);
	});

	it("refuses a folder Obsidian hasn't opened, and writes nothing", async () => {
		const target = tempFolder();
		const result = await install(["--vault", target, "--from", release()]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("isn't an Obsidian vault yet");
		expect(existsSync(join(target, ".obsidian"))).toBe(false);
	});

	it("refuses a community-plugins.json that isn't a list", async () => {
		const target = vault({ ".obsidian/community-plugins.json": '{"dataview": true}' });
		const result = await install(["--vault", target, "--from", release()]);

		expect(result.code).not.toBe(0);
		expect(readFileSync(join(target, ".obsidian", "community-plugins.json"), "utf8")).toBe('{"dataview": true}');
	});

	it("checks the files against checksums.txt and stops when they don't match", async () => {
		const from = release();
		const sum = (file: string) => createHash("sha256").update(readFileSync(join(from, file))).digest("hex");
		write(from, { "checksums.txt": ["main.js", "manifest.json", "styles.css"].map((f) => `${sum(f)}  ${f}`).join("\n") + "\n" });
		const target = vault();
		expect((await install(["--vault", target, "--from", from])).stdout).toContain("checksums checked: yes");

		write(from, { "main.js": "// tampered\n" });
		const other = vault();
		const result = await install(["--vault", other, "--from", from]);
		expect(result.code).not.toBe(0);
		expect(existsSync(pluginDir(other))).toBe(false);
	});

	it("refuses files that aren't theory.md's", async () => {
		const from = release();
		write(from, { "manifest.json": '{"id": "something-else"}' });
		const target = vault();

		expect((await install(["--vault", target, "--from", from])).code).not.toBe(0);
		expect(existsSync(pluginDir(target))).toBe(false);
	});

	it("lists the vaults Obsidian knows about", async () => {
		const home = tempFolder();
		write(home, {
			"Library/Application Support/obsidian/obsidian.json":
				'{"vaults":{"a1":{"path":"/Users/ada/Notes","ts":1,"open":true},"b2":{"path":"/Users/ada/Work model","ts":2}}}',
		});
		const result = await install(["--list-vaults"], { HOME: home, XDG_CONFIG_HOME: join(home, ".config") });

		expect(result.code).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["/Users/ada/Notes", "/Users/ada/Work model"]);
	});
});
