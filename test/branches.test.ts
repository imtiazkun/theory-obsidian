import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { finishBranches, prepareBranches } from "../src/branches";
import type { CompileReport } from "../src/compile";
import { commitFile, repo, sh, tempDir } from "./helpers";

// Tests never ask GitHub (TEST-6). No compile branch has a pull request here.
vi.mock("../src/github", async (original) => ({
	...(await original<typeof import("../src/github")>()),
	branchPullRequest: vi.fn(async () => null),
}));

const FIRST = "aaaaaaa1111111111111111111111111111111111";
const SECOND = "bbbbbbb2222222222222222222222222222222222";
const THIRD = "ccccccc3333333333333333333333333333333333";

function project() {
	const folder = tempDir();
	return { folder, app: repo(join(folder, "app")), api: repo(join(folder, "api")) };
}

function reportWith(branches: CompileReport["branches"]): CompileReport {
	return {
		id: "1",
		status: "succeeded",
		startedAt: new Date().toISOString(),
		fromCommit: null,
		toCommit: FIRST,
		revisions: [],
		summary: "",
		changes: [],
		questions: [],
		problems: [],
		log: [],
		branches,
	};
}

const branchOf = (dir: string) => sh(dir, ["symbolic-ref", "--short", "HEAD"]);

describe("compile branches across several repositories", () => {
	it("creates the same new branch from the checked-out branch in every repository", async () => {
		const { folder, app, api } = project();
		const prepared = await prepareBranches(folder, FIRST, []);
		expect(prepared.map((p) => [p.name, p.branch, p.base, p.created])).toEqual([
			["api", "theory/compile-aaaaaaa", "main", true],
			["app", "theory/compile-aaaaaaa", "main", true],
		]);
		expect(branchOf(app)).toBe("theory/compile-aaaaaaa");
		expect(branchOf(api)).toBe("theory/compile-aaaaaaa");
	});

	it("deletes an empty new branch and keeps one with commits", async () => {
		const { folder, app, api } = project();
		const prepared = await prepareBranches(folder, FIRST, []);
		commitFile(app, "src.ts", "code\n");
		const records = await finishBranches(prepared);

		const appRecord = records.find((r) => r.repo === "app")!;
		const apiRecord = records.find((r) => r.repo === "api")!;
		expect(appRecord.kept).toBe(true);
		expect(appRecord.commits.map((c) => c.subject)).toEqual(["Update src.ts"]);
		expect(apiRecord.kept).toBe(false);
		expect(apiRecord.commits).toEqual([]);
		expect(branchOf(app)).toBe("theory/compile-aaaaaaa");
		expect(branchOf(api)).toBe("main");
		expect(sh(api, ["branch", "--list", "theory/*"])).toBe("");
	});

	it("reuses the open compile branch instead of starting a second one", async () => {
		const { folder, app, api } = project();
		const first = await prepareBranches(folder, FIRST, []);
		commitFile(app, "src.ts", "code\n");
		const reports = [reportWith(await finishBranches(first))];
		sh(app, ["checkout", "-q", "main"]);

		const second = await prepareBranches(folder, SECOND, reports);
		const appBranch = second.find((p) => p.name === "app")!;
		const apiBranch = second.find((p) => p.name === "api")!;
		expect([appBranch.branch, appBranch.base, appBranch.created]).toEqual(["theory/compile-aaaaaaa", "main", false]);
		expect([apiBranch.branch, apiBranch.created]).toEqual(["theory/compile-bbbbbbb", true]);
		expect(branchOf(app)).toBe("theory/compile-aaaaaaa");
		expect(sh(app, ["branch", "--list", "theory/*"]).split("\n")).toHaveLength(1);
		expect(branchOf(api)).toBe("theory/compile-bbbbbbb");
	});

	it("starts fresh from the base once the compile branch is merged", async () => {
		const { folder, app } = project();
		const first = await prepareBranches(folder, FIRST, []);
		commitFile(app, "src.ts", "code\n");
		const reports = [reportWith(await finishBranches(first))];
		sh(app, ["checkout", "-q", "main"]);
		sh(app, ["merge", "-q", "--no-ff", "-m", "Merge compile", "theory/compile-aaaaaaa"]);

		const second = await prepareBranches(folder, THIRD, reports);
		const appBranch = second.find((p) => p.name === "app")!;
		expect([appBranch.branch, appBranch.base, appBranch.created]).toEqual(["theory/compile-ccccccc", "main", true]);
		expect(branchOf(app)).toBe("theory/compile-ccccccc");
		// The new branch starts from the merged base, so it already has the earlier change.
		expect(sh(app, ["log", "--format=%s", "-1", "theory/compile-ccccccc"])).toBe("Merge compile");
	});
});
