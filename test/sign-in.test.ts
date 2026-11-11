import { chmodSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { COMPILED_TAG, SIGN_IN_SUMMARY, signInFailed, startCompile } from "../src/compile";
import { commitFiles, initRepo, out, tempFolder, write } from "./helpers";

/** A fake Claude Code that answers like one that isn't signed in, or like one that finished without a report. */
function fakeClaude(root: string, result: string): string {
	const path = join(root, "bin", "claude");
	const event = JSON.stringify({ type: "result", subtype: "success", is_error: true, result });
	write(root, { "bin/claude": `#!/bin/sh\ncat >/dev/null &\necho '${event}'\nexit 1\n` });
	chmodSync(path, 0o755);
	return path;
}

async function compileWith(result: string) {
	const root = tempFolder();
	const vault = join(root, "vault");
	const project = join(root, "project");
	await initRepo(vault, { "Note.md": "# Note\n" });
	await git(vault, "First");
	await initRepo(join(project, "app"));
	const run = await startCompile(
		{
			vaultPath: vault,
			projectFolder: project,
			claudeCommand: fakeClaude(root, result),
			agent: "claude",
			permissionMode: "acceptEdits",
			allowedTools: "",
			model: "",
			effort: "",
			author: "Test Author",
			reports: [],
		},
		() => {},
	);
	return { vault, report: await run.done };

	async function git(repo: string, message: string) {
		await commitFiles(repo, { "Note.md": "# Note\n\nThe rule.\n" }, message);
	}
}

describe("Claude Code that isn't signed in (CMP-54)", () => {
	it("counts as a compile that can't start, and the marker doesn't move", async () => {
		const { vault, report } = await compileWith("Invalid API key · Please run /login");

		expect(report.status).toBe("failed");
		expect(report.summary).toBe(SIGN_IN_SUMMARY);
		expect(SIGN_IN_SUMMARY).toBe("Claude Code isn't signed in. Run claude in a terminal, then /login.");
		expect(await out(vault, ["tag", "--list", COMPILED_TAG])).toBe("");
	});

	it("an ordinary failure without a report still moves the marker", async () => {
		const { vault, report } = await compileWith("Something else went wrong.");

		expect(report.status).toBe("failed");
		expect(report.summary).toBe("Something else went wrong.");
		expect(await out(vault, ["tag", "--list", COMPILED_TAG])).toBe(COMPILED_TAG);
	});

	it("knows Claude Code's sign-in failures", () => {
		expect(signInFailed("Not logged in · Please run /login")).toBe(true);
		expect(signInFailed('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}')).toBe(true);
		expect(signInFailed("OAuth token has expired. Please obtain a new token or refresh your existing token.")).toBe(true);
		expect(signInFailed("The model changed the login page.")).toBe(false);
	});
});
