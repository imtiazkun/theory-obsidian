import type { CompileReport } from "./compile";
import type { PullRequest, PullRequestState } from "./github";

/** What asked for a refresh: a report or the compile history opening, the Refresh action, or the window's focus. */
export type RefreshReason = "report" | "history" | "action" | "focus";

/** A focus refresh this soon after the last one finished is skipped. */
export const FOCUS_REFRESH_GAP_MS = 30_000;

/** Only these states can still change. Merged and closed pull requests are never checked again. */
export function needsCheck(pr: PullRequest): boolean {
	return pr.state === "draft" || pr.state === "open";
}

export interface PullRequestStatesOptions {
	reports: () => CompileReport[];
	/** Asks GitHub for one pull request's state. */
	check: (pr: PullRequest) => Promise<PullRequestState>;
	/** Called once after a refresh that changed any state, to save and redraw. */
	changed: () => void | Promise<void>;
	now?: () => number;
}

/**
 * Refreshes pull request states across every report. One refresh runs at a time, its checks run side by
 * side, and a focus refresh is skipped within 30 seconds of the last one. A failed check keeps the saved state.
 */
export class PullRequestStates {
	private running: Promise<boolean> | null = null;
	private lastFinished: number | null = null;

	constructor(private options: PullRequestStatesOptions) {}

	/** Resolves to true when a state changed. */
	refresh(reason: RefreshReason): Promise<boolean> {
		if (this.running) {
			// The Refresh action is never skipped: it runs once the current refresh is done.
			if (reason !== "action") return this.running;
			return this.running.then(() => this.refresh(reason));
		}
		const now = this.options.now ?? Date.now;
		if (reason === "focus" && this.lastFinished !== null && now() - this.lastFinished < FOCUS_REFRESH_GAP_MS) {
			return Promise.resolve(false);
		}
		this.running = this.run().finally(() => {
			this.lastFinished = now();
			this.running = null;
		});
		return this.running;
	}

	private async run(): Promise<boolean> {
		// The same pull request may be recorded in several reports; GitHub is asked once per address.
		const byUrl = new Map<string, PullRequest[]>();
		for (const report of this.options.reports()) {
			for (const pr of report.pullRequests ?? []) {
				if (!needsCheck(pr)) continue;
				byUrl.set(pr.url, [...(byUrl.get(pr.url) ?? []), pr]);
			}
		}
		const results = await Promise.all(
			[...byUrl.values()].map(([first]) => this.options.check(first).catch(() => null)),
		);
		let changed = false;
		[...byUrl.values()].forEach((prs, i) => {
			const state = results[i];
			if (!state) return;
			for (const pr of prs) {
				if (pr.state === state) continue;
				pr.state = state;
				changed = true;
			}
		});
		if (changed) await this.options.changed();
		return changed;
	}
}
