import { describe, expect, it } from "vitest";
import { requestRules, withAllowedRules } from "../src/compile";

const suggestion = (...rules: { toolName: string; ruleContent?: string }[]) => [{ type: "addRules", behavior: "allow", destination: "session", rules }];

describe("Always allow (CFG-16)", () => {
	it("saves every rule Claude Code suggests for a command", () => {
		const rules = requestRules(
			"Bash",
			{ command: "cd app && npm test" },
			"/project",
			suggestion({ toolName: "Bash", ruleContent: "cd:*" }, { toolName: "Bash", ruleContent: "npm test:*" }),
		);
		expect(rules).toEqual(["Bash(cd:*)", "Bash(npm test:*)"]);
	});

	it("saves the exact command when Claude Code suggests none", () => {
		expect(requestRules("Bash", { command: "npm run build" }, "/project", undefined)).toEqual(["Bash(npm run build)"]);
	});

	it("saves a file tool on that exact file, never the bare tool or Claude Code's suggestion", () => {
		const rules = requestRules("Edit", { file_path: "/Users/someone/.zshrc" }, "/project", suggestion({ toolName: "Edit" }));
		expect(rules).toEqual(["Edit(//Users/someone/.zshrc)"]);
		expect(requestRules("Write", { file_path: "src/new.ts" }, "/project", undefined)).toEqual(["Write(//project/src/new.ts)"]);
	});

	it("saves Claude Code's suggestion for any other tool, else the tool's name", () => {
		expect(requestRules("WebFetch", { url: "https://example.com" }, "/project", suggestion({ toolName: "WebFetch", ruleContent: "domain:example.com" }))).toEqual([
			"WebFetch(domain:example.com)",
		]);
		expect(requestRules("WebSearch", { query: "x" }, "/project", undefined)).toEqual(["WebSearch"]);
	});

	it("adds the rules at the end of Allowed commands, never one twice", () => {
		expect(withAllowedRules("Bash(git *) Bash(cd:*)", ["Bash(cd:*)", "Bash(npm test:*)"])).toBe("Bash(git *) Bash(cd:*) Bash(npm test:*)");
		expect(withAllowedRules("", ["Bash(npm test:*)"])).toBe("Bash(npm test:*)");
	});
});
