import { MarkdownView, TFile, getIconIds, setIcon } from "obsidian";
import { COMPILED_TAG } from "./compile";
import type TheoryPlugin from "./main";
import { git } from "./vault";

/**
 * Front matter key an engineer clears to say a note is written ahead of the code.
 * Absent means realized, so only `realized: false` is ever written to a note.
 */
export const REALIZED_KEY = "realized";

type CompileState = "new" | "pending" | "running" | "failed" | "compiled";

const COMPILE_STATE: Record<CompileState, { icons: string[]; label: string }> = {
	new: { icons: ["circle-dashed"], label: "Not committed yet" },
	pending: { icons: ["clock"], label: "Committed, waiting for a compile" },
	running: { icons: ["loader"], label: "Compiling…" },
	failed: { icons: ["circle-x", "x-circle"], label: "The last compile of this note failed. Click for the report." },
	compiled: { icons: ["circle-check", "check-circle"], label: "Compiled" },
};

/** The first icon this Obsidian version has, since Lucide renames icons between versions. */
function icon(names: string[]): string {
	const ids = getIconIds();
	return names.find((name) => ids.includes(`lucide-${name}`)) ?? names[names.length - 1];
}

interface GitState {
	/** Paths git tracks. */
	tracked: Set<string>;
	/** Paths changed since the last compile, or every path when nothing has been compiled. */
	pending: Set<string> | "all";
}

interface StatusButtons {
	realized: HTMLElement;
	compile: HTMLElement;
}

/**
 * Two buttons in every note's header: whether the engineer says the note is realized,
 * and what the compiles have done with it.
 */
export class NoteStatus {
	private buttons = new Map<MarkdownView, StatusButtons>();
	// Ignores results from an older sync that finishes after a newer one.
	private syncId = 0;

	constructor(private plugin: TheoryPlugin) {}

	isRealized(file: TFile): boolean {
		return this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[REALIZED_KEY] !== false;
	}

	async toggleRealized(file: TFile | null) {
		if (!file) return;
		const realized = this.isRealized(file);
		await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (realized) frontmatter[REALIZED_KEY] = false;
			else delete frontmatter[REALIZED_KEY];
		});
	}

	async sync() {
		const id = ++this.syncId;
		const setUp = this.plugin.isVaultSetUp();
		const state = setUp ? await this.readGitState().catch(() => null) : null;
		if (id !== this.syncId) return;

		for (const [view, buttons] of this.buttons) {
			if (!buttons.realized.isConnected) this.buttons.delete(view);
		}
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;

			let buttons = this.buttons.get(view);
			if (!buttons) {
				// Header actions are added right to left, so the realized box sits left of the compile state.
				const compile = view.addAction("clock", "", () => this.plugin.showReportView());
				compile.addClass("theory-state-button");
				const realized = view.addAction("square", "", () => this.toggleRealized(view.file));
				realized.addClass("theory-realized-button");
				buttons = { realized, compile };
				this.buttons.set(view, buttons);
			}

			const file = view.file;
			const shown = setUp && file !== null && file.extension === "md";
			buttons.realized.toggle(shown);
			buttons.compile.toggle(shown && state !== null);
			if (!shown || !file) continue;

			const realized = this.isRealized(file);
			setIcon(buttons.realized, icon(realized ? ["square-check", "check-square"] : ["square"]));
			buttons.realized.toggleClass("is-realized", realized);
			buttons.realized.setAttr(
				"aria-label",
				realized ? "Realized. Click to mark as written ahead of the code." : "Not realized yet. Click to mark as realized.",
			);

			if (!state) continue;
			const compileState = this.compileState(file.path, state);
			const { icons, label } = COMPILE_STATE[compileState];
			setIcon(buttons.compile, icon(icons));
			for (const kind of Object.keys(COMPILE_STATE)) buttons.compile.toggleClass(`is-${kind}`, kind === compileState);
			buttons.compile.setAttr("aria-label", label);
		}
	}

	private async readGitState(): Promise<GitState> {
		const vaultPath = this.plugin.getVaultPath();
		const { stdout: files } = await git(vaultPath, ["ls-files", "-z"]);
		const tracked = new Set(files.split("\0").filter(Boolean));
		try {
			const { stdout } = await git(vaultPath, ["diff", "--name-only", "-z", `refs/tags/${COMPILED_TAG}`, "HEAD"]);
			return { tracked, pending: new Set(stdout.split("\0").filter(Boolean)) };
		} catch {
			// No compile marker yet.
			return { tracked, pending: "all" };
		}
	}

	private compileState(path: string, { tracked, pending }: GitState): CompileState {
		if (!tracked.has(path)) return "new";
		if (pending === "all" || pending.has(path)) return this.plugin.isCompiling() ? "running" : "pending";
		// The newest compile that built this note, or pointed a problem at it, decides.
		const report = this.plugin.reports.find(
			(r) =>
				r.status !== "running" &&
				(r.suspectNotes?.includes(path) || r.problems.some((p) => p.anchors.some((a) => a.path === path))),
		);
		return report?.status === "failed" ? "failed" : "compiled";
	}

	removeAll() {
		for (const { realized, compile } of this.buttons.values()) {
			realized.remove();
			compile.remove();
		}
		this.buttons.clear();
	}
}
