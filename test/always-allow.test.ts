import { describe, expect, it } from "vitest";
import { requestRules, withAllowedRules } from "../src/compile";

const PROJECT = "/work/project";

function suggest(...rules: { toolName: string; ruleContent?: string }[]) {
	return [{ type: "addRules", behavior: "allow", destination: "session", rules }];
}

describe("Always allow (CFG-16)", () => {
	it("saves every rule Claude Code suggests for a command, once each", () => {
		const suggestions = [
			...suggest({ toolName: "Bash", ruleContent: "npm run:*" }, { toolName: "Bash", ruleContent: "npm test:*" }),
			...suggest({ toolName: "Bash", ruleContent: "npm run:*" }),
			{ type: "addRules", behavior: "deny", rules: [{ toolName: "Bash", ruleContent: "rm:*" }] },
			{ type: "setMode", mode: "acceptEdits" },
		];
		expect(requestRules("Bash", { command: "npm run build && npm test" }, PROJECT, suggestions)).toEqual([
			"Bash(npm run:*)",
			"Bash(npm test:*)",
		]);
	});

	it("saves the exact command when Claude Code suggests none", () => {
		expect(requestRules("Bash", { command: "npm run build" }, PROJECT, undefined)).toEqual(["Bash(npm run build)"]);
		expect(requestRules("Bash", { command: "ls" }, PROJECT, suggest({ toolName: "Read" }))).toEqual(["Bash(ls)"]);
	});

	it("saves a file tool on that exact file, never the bare tool or Claude Code's suggestion", () => {
		const suggestions = suggest({ toolName: "Edit" });
		expect(requestRules("Edit", { file_path: "/Users/ada/.zshrc" }, PROJECT, suggestions)).toEqual(["Edit(//Users/ada/.zshrc)"]);
		expect(requestRules("Write", { file_path: "src/a.ts" }, PROJECT, suggestions)).toEqual(["Write(//work/project/src/a.ts)"]);
		expect(requestRules("NotebookEdit", { notebook_path: "/n/a.ipynb" }, PROJECT, undefined)).toEqual([
			"NotebookEdit(//n/a.ipynb)",
		]);
		expect(requestRules("Edit", {}, PROJECT, suggestions)).toEqual([]);
	});

	it("saves Claude Code's suggestion for any other tool, else the tool's name", () => {
		expect(requestRules("WebFetch", { url: "https://x.dev" }, PROJECT, suggest({ toolName: "WebFetch", ruleContent: "domain:x.dev" }))).toEqual([
			"WebFetch(domain:x.dev)",
		]);
		expect(requestRules("WebSearch", { query: "q" }, PROJECT, undefined)).toEqual(["WebSearch"]);
	});

	it("adds the rules to the end of Allowed commands, never one twice", () => {
		expect(withAllowedRules("", ["Bash(npm run:*)"])).toBe("Bash(npm run:*)");
		expect(withAllowedRules("  Bash(git *) Bash(npm run build) ", ["Bash(npm run build)", "Bash(ls)", "Bash(ls)"])).toBe(
			"Bash(git *) Bash(npm run build) Bash(ls)",
		);
		// A rule that is only part of another rule is still added.
		expect(withAllowedRules("Bash(npm run build)", ["Bash(npm run)"])).toBe("Bash(npm run build) Bash(npm run)");
	});
});
