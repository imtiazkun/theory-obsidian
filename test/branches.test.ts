import { join } from "path";
import { describe, expect, it } from "vitest";
import { CompileBranch, currentBranch, finishBranches, isOpenCompileBranch, prepareBranches, recordedPullRequest } from "../src/branches";
import type { CompileReport } from "../src/compile";
import type { PullRequest } from "../src/github";
import { commitFiles, initRepo, out, tempFolder } from "./helpers";

const FIRST = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A project folder holding the repositories `api` and `web` side by side, both on `main`. */
async function project() {
	const folder = tempFolder();
	const api = join(folder, "api");
	const web = join(folder, "web");
	await initRepo(api);
	await initRepo(web);
	return { folder, api, web };
}

/** The report a finished compile leaves behind, as far as compile branches care. */
function reportWith(branches: CompileBranch[], pullRequests: PullRequest[] = []): CompileReport {
	return { branches, pullRequests } as CompileReport;
}

async function branches(repo: string): Promise<string[]> {
	return (await out(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n").filter(Boolean);
}

describe("compile branches", () => {
	it("creates the same new branch in every repository, from the branch checked out", async () => {
		const { folder, api, web } = await project();
		await out(web, ["checkout", "-b", "develop"]);

		const prepared = await prepareBranches(folder, FIRST, []);

		expect(prepared.map((p) => [p.name, p.branch, p.base, p.created])).toEqual([
			["api", "theory/compile-1111111", "main", true],
			["web", "theory/compile-1111111", "develop", true],
		]);
		expect(await currentBranch(api)).toBe("theory/compile-1111111");
		expect(await currentBranch(web)).toBe("theory/compile-1111111");
	});

	it("deletes a new branch that got no commits and keeps one that did", async () => {
		const { folder, api, web } = await project();
		const prepared = await prepareBranches(folder, FIRST, []);
		await commitFiles(api, { "a.ts": "a\n" }, "Add a");

		const records = await finishBranches(prepared);

		expect(records.map((r) => [r.repo, r.kept, r.commits.map((c) => c.subject)])).toEqual([
			["api", true, ["Add a"]],
			["web", false, []],
		]);
		expect(await currentBranch(api)).toBe("theory/compile-1111111");
		expect(await currentBranch(web)).toBe("main");
		expect(await branches(web)).toEqual(["main"]);
	});

	it("reuses the open compile branch instead of starting a second one", async () => {
		const { folder, api, web } = await project();
		const first = await prepareBranches(folder, FIRST, []);
		await commitFiles(api, { "a.ts": "a\n" }, "Add a");
		await commitFiles(web, { "w.ts": "w\n" }, "Add w");
		const reports = [reportWith(await finishBranches(first))];
		// The engineer went back to main in one repository between compiles.
		await out(api, ["checkout", "main"]);

		const second = await prepareBranches(folder, SECOND, reports);

		expect(second.map((p) => [p.name, p.branch, p.base, p.created, p.previous])).toEqual([
			["api", "theory/compile-1111111", "main", false, "main"],
			["web", "theory/compile-1111111", "main", false, "theory/compile-1111111"],
		]);
		expect(await currentBranch(api)).toBe("theory/compile-1111111");
		expect(await branches(api)).toEqual(["main", "theory/compile-1111111"]);

		// A reused branch that got nothing new stays, with its earlier commits.
		const records = await finishBranches(second);
		expect(records.map((r) => [r.repo, r.kept, r.commits.length])).toEqual([
			["api", true, 0],
			["web", true, 0],
		]);
		expect(await branches(web)).toEqual(["main", "theory/compile-1111111"]);
	});

	it("starts a fresh branch once the open one is merged into its base", async () => {
		const { folder, api, web } = await project();
		const first = await prepareBranches(folder, FIRST, []);
		await commitFiles(api, { "a.ts": "a\n" }, "Add a");
		await commitFiles(web, { "w.ts": "w\n" }, "Add w");
		const reports = [reportWith(await finishBranches(first))];
		for (const repo of [api, web]) {
			await out(repo, ["checkout", "main"]);
			await out(repo, ["merge", "--no-ff", "-m", "Merge compile", "theory/compile-1111111"]);
		}

		const second = await prepareBranches(folder, SECOND, reports);

		expect(second.map((p) => [p.name, p.branch, p.base, p.created])).toEqual([
			["api", "theory/compile-2222222", "main", true],
			["web", "theory/compile-2222222", "main", true],
		]);
		expect(await out(api, ["rev-parse", "HEAD"])).toBe(await out(api, ["rev-parse", "main"]));
	});

	it("starts a fresh branch when the open one's pull request was closed", async () => {
		const { folder, api, web } = await project();
		const first = await prepareBranches(folder, FIRST, []);
		await commitFiles(api, { "a.ts": "a\n" }, "Add a");
		const records = await finishBranches(first);
		const closed: PullRequest = {
			repoPath: api,
			repo: "api",
			branch: "theory/compile-1111111",
			base: "main",
			url: "https://github.com/example/api/pull/1",
			state: "closed",
		};
		await out(api, ["checkout", "main"]);

		const second = await prepareBranches(folder, SECOND, [reportWith(records, [closed])]);

		expect(second.map((p) => [p.name, p.branch, p.created])).toEqual([
			["api", "theory/compile-2222222", true],
			["web", "theory/compile-2222222", true],
		]);
		expect(await currentBranch(web)).toBe("theory/compile-2222222");
	});

	it("starting on a finished compile branch goes back to that branch's base", async () => {
		const { folder, api } = await project();
		const first = await prepareBranches(folder, FIRST, []);
		await commitFiles(api, { "a.ts": "a\n" }, "Add a");
		const records = await finishBranches(first);
		await out(api, ["checkout", "main"]);
		await out(api, ["merge", "--no-ff", "-m", "Merge compile", "theory/compile-1111111"]);
		await out(api, ["checkout", "theory/compile-1111111"]);

		const [prepared] = await prepareBranches(folder, SECOND, [reportWith(records)]);

		expect([prepared.branch, prepared.base, prepared.created]).toEqual(["theory/compile-2222222", "main", true]);
	});

	it("a closed pull request from an older branch of the same name doesn't count for a recompiled branch", async () => {
		const { folder, api } = await project();
		const first = await prepareBranches(folder, FIRST, []);
		await commitFiles(api, { "a.ts": "a\n" }, "Add a");
		const firstRecords = await finishBranches(first);
		const closed: PullRequest = {
			repoPath: api,
			repo: "api",
			branch: "theory/compile-1111111",
			base: "main",
			url: "https://github.com/example/api/pull/1",
			state: "closed",
		};
		const closedReport = reportWith(firstRecords, [closed]);
		// The engineer deletes the closed branch and compiles the same revision again.
		await out(api, ["checkout", "main"]);
		await out(api, ["branch", "-D", "theory/compile-1111111"]);
		const again = await prepareBranches(folder, FIRST, [closedReport]);
		await commitFiles(api, { "b.ts": "b\n" }, "Add b");
		const reports = [reportWith(await finishBranches(again)), closedReport];

		expect(await recordedPullRequest(reports, api, "theory/compile-1111111")).toBeNull();
		expect(await isOpenCompileBranch(api, "theory/compile-1111111", "main", reports)).toBe(true);
	});

	it("a pull request recorded for the branch it was opened from still counts", async () => {
		const { folder, api } = await project();
		const first = await prepareBranches(folder, FIRST, []);
		await commitFiles(api, { "a.ts": "a\n" }, "Add a");
		const open: PullRequest = {
			repoPath: api,
			repo: "api",
			branch: "theory/compile-1111111",
			base: "main",
			url: "https://github.com/example/api/pull/1",
			state: "open",
		};
		const reports = [reportWith(await finishBranches(first), [open])];

		expect(await recordedPullRequest(reports, api, "theory/compile-1111111")).toEqual(open);
		expect(await isOpenCompileBranch(api, "theory/compile-1111111", "main", reports)).toBe(true);
	});

	describe("the base is up to date", () => {
		/** Gives `repo` an `origin` with its `main`, and returns a second clone to push new commits from. */
		async function withOrigin(repo: string) {
			const root = tempFolder();
			const remote = join(root, "remote.git");
			await out(root, ["init", "--bare", "-b", "main", remote]);
			await out(repo, ["remote", "add", "origin", remote]);
			await out(repo, ["push", "-u", "origin", "main"]);
			const other = join(root, "other");
			await out(root, ["clone", remote, other]);
			return { other };
		}

		/** Pushes a new commit to `origin/main` from the other clone, and fetches it into `repo`. */
		async function remoteCommit(repo: string, other: string, file: string): Promise<string> {
			const hash = await commitFiles(other, { [file]: `${file}\n` }, `Add ${file}`);
			await out(other, ["push", "origin", "main"]);
			await out(repo, ["fetch", "--quiet"]);
			return hash;
		}

		it("fast-forwards a checked-out base that is behind before the new branch starts", async () => {
			const { folder, api } = await project();
			const { other } = await withOrigin(api);
			const newest = await remoteCommit(api, other, "r.ts");

			await prepareBranches(folder, FIRST, []);

			expect(await currentBranch(api)).toBe("theory/compile-1111111");
			expect(await out(api, ["rev-parse", "HEAD"])).toBe(newest);
			expect(await out(api, ["rev-parse", "main"])).toBe(newest);
		});

		it("fast-forwards a base that isn't checked out", async () => {
			const { folder, api } = await project();
			const { other } = await withOrigin(api);
			const first = await prepareBranches(folder, FIRST, []);
			await commitFiles(api, { "a.ts": "a\n" }, "Add a");
			const records = await finishBranches(first);
			// The compile branch was merged on the remote, and the engineer is still on it.
			await out(api, ["push", "origin", "theory/compile-1111111"]);
			await out(other, ["fetch", "origin"]);
			await out(other, ["merge", "--no-ff", "-m", "Merge compile", "origin/theory/compile-1111111"]);
			await out(other, ["push", "origin", "main"]);
			await out(api, ["fetch", "--quiet"]);
			const newest = await out(api, ["rev-parse", "origin/main"]);

			const [prepared] = await prepareBranches(folder, SECOND, [reportWith(records)]);

			expect([prepared.branch, prepared.base, prepared.created]).toEqual(["theory/compile-2222222", "main", true]);
			expect(await out(api, ["rev-parse", "main"])).toBe(newest);
			expect(await out(api, ["rev-parse", "HEAD"])).toBe(newest);
		});

		it("doesn't start when the base and its upstream both have new commits", async () => {
			const { folder, api, web } = await project();
			const { other } = await withOrigin(api);
			await remoteCommit(api, other, "r.ts");
			const own = await commitFiles(api, { "l.ts": "l\n" }, "Add l");

			await expect(prepareBranches(folder, FIRST, [])).rejects.toThrow(
				"main in api and origin/main both have new commits. Pull with rebase in git, then compile again.",
			);
			expect(await out(api, ["rev-parse", "main"])).toBe(own);
			expect(await branches(api)).toEqual(["main"]);
			expect(await branches(web)).toEqual(["main"]);
		});

		it("uses what the last fetch saw, and never fetches itself", async () => {
			const { folder, api } = await project();
			const { other } = await withOrigin(api);
			const before = await out(api, ["rev-parse", "main"]);
			await commitFiles(other, { "r.ts": "r\n" }, "Add r");
			await out(other, ["push", "origin", "main"]);

			await prepareBranches(folder, FIRST, []);

			expect(await out(api, ["rev-parse", "HEAD"])).toBe(before);
		});

		it("doesn't reuse an open branch that lacks commits from its base", async () => {
			const { folder, api } = await project();
			const first = await prepareBranches(folder, FIRST, []);
			await commitFiles(api, { "a.ts": "a\n" }, "Add a");
			const reports = [reportWith(await finishBranches(first))];
			await out(api, ["checkout", "main"]);
			await commitFiles(api, { "m.ts": "m\n" }, "Add m");

			await expect(prepareBranches(folder, SECOND, reports)).rejects.toThrow(
				"theory/compile-1111111 in api is missing commits from main. Merge main into it, then compile again.",
			);
			expect(await currentBranch(api)).toBe("main");
			expect(await branches(api)).toEqual(["main", "theory/compile-1111111"]);
		});

		it("doesn't reuse an open branch that lacks commits from its base's upstream", async () => {
			const { folder, api } = await project();
			const { other } = await withOrigin(api);
			const first = await prepareBranches(folder, FIRST, []);
			await commitFiles(api, { "a.ts": "a\n" }, "Add a");
			const reports = [reportWith(await finishBranches(first))];
			await remoteCommit(api, other, "r.ts");

			await expect(prepareBranches(folder, SECOND, reports)).rejects.toThrow("is missing commits from main");
		});

		it("reuses an open branch that has every commit of its base", async () => {
			const { folder, api } = await project();
			await withOrigin(api);
			const first = await prepareBranches(folder, FIRST, []);
			await commitFiles(api, { "a.ts": "a\n" }, "Add a");
			const reports = [reportWith(await finishBranches(first))];

			const [prepared] = await prepareBranches(folder, SECOND, reports);

			expect([prepared.branch, prepared.created]).toEqual(["theory/compile-1111111", false]);
		});
	});
});
