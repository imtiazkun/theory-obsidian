import { describe, expect, it } from "vitest";
import type { CompileReport } from "../src/compile";
import type { PullRequest, PullRequestState } from "../src/github";
import { FOCUS_REFRESH_GAP_MS, PullRequestStates } from "../src/pr-states";

function pr(url: string, state: PullRequestState): PullRequest {
	return { repoPath: "/repo", repo: "repo", branch: "theory/compile-x", base: "main", url, state };
}

function report(id: string, pullRequests: PullRequest[]): CompileReport {
	return { id, pullRequests } as unknown as CompileReport;
}

/** A refresher over `reports` whose GitHub answers come from `answers` (url → state, or an error). */
function refresher(reports: CompileReport[], answers: Record<string, PullRequestState | Error>) {
	const checked: string[] = [];
	let changes = 0;
	let time = 0;
	const states = new PullRequestStates({
		reports: () => reports,
		check: async (p) => {
			checked.push(p.url);
			const answer = answers[p.url];
			if (answer instanceof Error || answer === undefined) throw answer ?? new Error("offline");
			return answer;
		},
		changed: () => {
			changes++;
		},
		now: () => time,
	});
	return {
		states,
		checked,
		changes: () => changes,
		advance: (ms: number) => (time += ms),
	};
}

describe("pull request states", () => {
	it("checks only draft and open pull requests, across every report", async () => {
		const reports = [
			report("2", [pr("a", "draft"), pr("b", "merged")]),
			report("1", [pr("c", "open"), pr("d", "closed")]),
		];
		const r = refresher(reports, { a: "open", c: "merged" });
		expect(await r.states.refresh("report")).toBe(true);
		expect(r.checked.sort()).toEqual(["a", "c"]);
		expect(reports[0].pullRequests?.map((p) => p.state)).toEqual(["open", "merged"]);
		expect(reports[1].pullRequests?.map((p) => p.state)).toEqual(["merged", "closed"]);
		expect(r.changes()).toBe(1);
	});

	it("keeps the saved state when a check fails, and reports no change", async () => {
		const reports = [report("1", [pr("a", "open"), pr("b", "draft")])];
		const r = refresher(reports, { a: new Error("gh isn't logged in"), b: "draft" });
		expect(await r.states.refresh("action")).toBe(false);
		expect(reports[0].pullRequests?.map((p) => p.state)).toEqual(["open", "draft"]);
		expect(r.changes()).toBe(0);
	});

	it("skips a focus refresh within 30 seconds of the last one, but never the Refresh action", async () => {
		const r = refresher([report("1", [pr("a", "open")])], { a: "open" });
		await r.states.refresh("history");
		expect(r.checked).toEqual(["a"]);

		r.advance(FOCUS_REFRESH_GAP_MS - 1);
		await r.states.refresh("focus");
		expect(r.checked).toEqual(["a"]);

		await r.states.refresh("action");
		expect(r.checked).toEqual(["a", "a"]);

		r.advance(FOCUS_REFRESH_GAP_MS);
		await r.states.refresh("focus");
		expect(r.checked).toEqual(["a", "a", "a"]);
	});

	it("runs one refresh at a time, with its checks side by side", async () => {
		const pending: (() => void)[] = [];
		let started = 0;
		const states = new PullRequestStates({
			reports: () => [report("1", [pr("a", "open"), pr("b", "open")])],
			check: () => {
				started++;
				return new Promise<PullRequestState>((resolve) => pending.push(() => resolve("open")));
			},
			changed: () => {},
		});
		const first = states.refresh("report");
		const second = states.refresh("focus");
		await Promise.resolve();
		// Both checks started before either finished, and the second refresh started none of its own.
		expect(started).toBe(2);
		pending.forEach((resolve) => resolve());
		await Promise.all([first, second]);
		expect(started).toBe(2);
	});
});
