import { MarkdownView } from "obsidian";
import type TheoryPlugin from "./main";
import { countRules, ruleCountLabel, ruleCountTooltip } from "./rule-count";

/**
 * Shows how many rules the open note declares, left of the other header icons (HDR-9). Worked out from
 * the note's text as it is now, uncommitted edits included, and never stored (HDR-11).
 */
export class RuleCounts {
	private labels = new Map<MarkdownView, HTMLElement>();

	constructor(private plugin: TheoryPlugin) {}

	sync() {
		for (const [view, label] of this.labels) {
			if (!label.isConnected) this.labels.delete(view);
		}
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView) this.render(view);
		}
	}

	private render(view: MarkdownView) {
		const actions = view.containerEl.querySelector(".view-header .view-actions");
		if (!actions) return;
		let label = this.labels.get(view);
		if (!label) {
			label = createSpan({ cls: "theory-rule-count" });
			this.labels.set(view, label);
		}
		// Kept first, so it stays left of icons added later.
		if (actions.firstChild !== label) actions.prepend(label);

		const file = view.file;
		const count = file?.extension === "md" ? countRules(view.getViewData()) : null;
		const text = count ? ruleCountLabel(count) : "";
		label.toggle(text !== "");
		if (!count || text === "") return;
		label.setText(text);
		label.setAttr("aria-label", ruleCountTooltip(count));
		label.toggleClass("is-duplicate", count.duplicates.length > 0);
	}

	removeAll() {
		for (const label of this.labels.values()) label.remove();
		this.labels.clear();
	}
}
