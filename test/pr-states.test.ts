import { describe, expect, it, vi } from "vitest";
import type { CompileReport } from "../src/compile";
import type { PullRequest, PullRequestState } from "../src/github";
import { FOCUS_COOLDOWN_MS, PullRequestStates } from "../src/pr-states";

function pr(repo: string, state: PullRequestState): PullRequest {
	return { repoPath: `/project/${repo}`, repo, branch: "theory/compile-aaaaaaa", base: "main", url: `https://github.com/o/${repo}/pull/1`, state };
}

function report(id: string, pullRequests: PullRequest[]): CompileReport {
	return {
		id,
		status: "succeeded",
		startedAt: "2026-11-03T00:00:00Z",
		fromCommit: null,
		toCommit: "a",
		revisions: [],
		summary: "",
		changes: [],
		questions: [],
		problems: [],
		log: [],
		pullRequests,
	};
}

/** A fake GitHub: every pull request is now in `state`. Tests never call gh (TEST-6). */
function setup(reports: CompileReport[], answer: (pr: PullRequest) => Promise<PullRequestState>) {
	let now = 1_000_000;
	const check = vi.fn(answer);
	const changed = vi.fn();
	const states = new PullRequestStates(() => reports, check, changed, () => now);
	return { states, check, changed, advance: (ms: number) => (now += ms) };
}

describe("pull request states", () => {
	it("checks only draft and open pull requests, across every report", async () => {
		const open = pr("app", "open");
		const draft = pr("api", "draft");
		const reports = [report("2", [open, pr("web", "merged")]), report("1", [draft, pr("cli", "closed")])];
		const { states, check, changed } = setup(reports, async () => "merged");

		expect(await states.refresh("open")).toBe(true);
		expect(check.mock.calls.map(([p]) => p.repo).sort()).toEqual(["api", "app"]);
		expect([open.state, draft.state]).toEqual(["merged", "merged"]);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("keeps the saved state when a check fails, and shows nothing", async () => {
		const open = pr("app", "open");
		const draft = pr("api", "draft");
		const { states, changed } = setup([report("1", [open, draft])], async (p) => {
			if (p.repo === "app") throw new Error("gh isn't logged in");
			return "draft";
		});
		expect(await states.refresh("action")).toBe(false);
		expect([open.state, draft.state]).toEqual(["open", "draft"]);
		expect(changed).not.toHaveBeenCalled();
	});

	it("skips a focus refresh within 30 seconds of the last one, but never the Refresh action", async () => {
		const { states, check, advance } = setup([report("1", [pr("app", "open")])], async () => "open");
		await states.refresh("open");
		expect(check).toHaveBeenCalledTimes(1);

		advance(FOCUS_COOLDOWN_MS - 1);
		await states.refresh("focus");
		expect(check).toHaveBeenCalledTimes(1);

		await states.refresh("action");
		expect(check).toHaveBeenCalledTimes(2);

		advance(FOCUS_COOLDOWN_MS);
		await states.refresh("focus");
		expect(check).toHaveBeenCalledTimes(3);
	});

	it("runs one refresh at a time and checks its pull requests side by side", async () => {
		let running = 0;
		let most = 0;
		const release: (() => void)[] = [];
		const { states, check } = setup([report("1", [pr("app", "open"), pr("api", "open")])], async () => {
			running++;
			most = Math.max(most, running);
			await new Promise<void>((resolve) => release.push(resolve));
			running--;
			return "open";
		});
		const first = states.refresh("open");
		const second = states.refresh("focus");
		const third = states.refresh("open");
		await vi.waitFor(() => expect(release).toHaveLength(2));
		expect(most).toBe(2);
		release.splice(0).forEach((done) => done());
		await Promise.all([first, second, third]);
		expect(check).toHaveBeenCalledTimes(2);
	});
});
