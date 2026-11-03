import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkProblems } from "../src/anchor";
import { tempDir, write } from "./helpers";

function snapshot() {
	const dir = realpathSync(tempDir());
	write(dir, "app/Rules.md", "# Rules\n\n## Refunds\n\nA refund is rejected after 30 days.\n");
	return dir;
}

const problem = (anchors: unknown[]) => [{ problem: "Something is wrong", anchors }];

describe("anchors", () => {
	it("keeps an anchor whose file, heading and quote are in the snapshot", async () => {
		const [p] = await checkProblems(
			snapshot(),
			problem([{ path: "app/Rules.md", heading: "Refunds", quote: "A refund is rejected after 30 days." }]),
		);
		expect(p.anchors).toEqual([{ path: "app/Rules.md", heading: "Refunds", quote: "A refund is rejected after 30 days." }]);
	});

	it("drops a heading or quote that isn't in the file, and keeps the file", async () => {
		const [p] = await checkProblems(snapshot(), problem([{ path: "app/Rules.md", heading: "Returns", quote: "never refunded" }]));
		expect(p.anchors).toEqual([{ path: "app/Rules.md" }]);
	});

	it("drops an anchor whose file isn't in the snapshot", async () => {
		const [p] = await checkProblems(snapshot(), problem([{ path: "app/Missing.md" }, { path: "../outside.md" }, { path: "/etc/hosts" }]));
		expect(p.anchors).toEqual([]);
	});

	it("drops every anchor when there is no snapshot to check against", async () => {
		const [p] = await checkProblems(null, problem([{ path: "app/Rules.md", heading: "Refunds" }]));
		expect(p).toEqual({ text: "Something is wrong", anchors: [] });
	});
});
