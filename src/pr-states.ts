import type { CompileReport } from "./compile";
import type { PullRequest, PullRequestState } from "./github";

/** What asked for a refresh. Only these moments ask GitHub, never a timer (REP-34, REP-36). */
export type RefreshTrigger = "open" | "action" | "focus";

/** A focus refresh this soon after the last one finished is skipped. */
export const FOCUS_COOLDOWN_MS = 30_000;

/** States that can still change. Merged and closed pull requests are never checked again. */
const LIVE: PullRequestState[] = ["draft", "open"];

/**
 * Keeps the saved pull request states in step with GitHub. One refresh runs at a time and checks its pull requests
 * side by side. A check that fails keeps the saved state and is shown nowhere.
 */
export class PullRequestStates {
	private running: Promise<boolean> | null = null;
	private queued: Promise<boolean> | null = null;
	private lastFinished = Number.NEGATIVE_INFINITY;

	constructor(
		private reports: () => CompileReport[],
		private check: (pr: PullRequest) => Promise<PullRequestState>,
		/** Called once a refresh changed a state, to save the reports and redraw every view that shows one. */
		private changed: () => Promise<void> | void,
		private now: () => number = Date.now,
	) {}

	/** Resolves to true when a state changed. */
	refresh(trigger: RefreshTrigger): Promise<boolean> {
		if (trigger === "focus" && !this.running && this.now() - this.lastFinished < FOCUS_COOLDOWN_MS) {
			return Promise.resolve(false);
		}
		if (!this.running) return this.start();
		// The Refresh action is never skipped: it runs again once the current refresh is done.
		if (trigger !== "action") return this.running;
		this.queued ??= this.running.then(() => {
			this.queued = null;
			return this.running ?? this.start();
		});
		return this.queued;
	}

	private start(): Promise<boolean> {
		const run = this.run().finally(() => {
			this.lastFinished = this.now();
			if (this.running === run) this.running = null;
		});
		this.running = run;
		return run;
	}

	private async run(): Promise<boolean> {
		const live = this.reports().flatMap((report) => (report.pullRequests ?? []).filter((pr) => LIVE.includes(pr.state)));
		const states = await Promise.all(live.map((pr) => this.check(pr).catch(() => null)));
		let changed = false;
		live.forEach((pr, i) => {
			const state = states[i];
			if (state && state !== pr.state) {
				pr.state = state;
				changed = true;
			}
		});
		if (changed) await this.changed();
		return changed;
	}
}
