import { symlinkSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { checkAnchors, checkProblems } from "../src/anchor";
import { tempFolder, write } from "./helpers";

const NOTE = `Intro line.

## Starting a compile

**CMP-1.** A compile starts from the Compile button.
`;

function snapshot() {
	const dir = tempFolder();
	write(dir, { "app/Compile.md": NOTE });
	return dir;
}

describe("anchors", () => {
	it("keeps the file, heading and quote when all are in the snapshot", async () => {
		const anchors = await checkAnchors(snapshot(), [
			{ path: "app/Compile.md", heading: "Starting a compile", quote: "A compile starts from   the Compile button." },
		]);
		expect(anchors).toEqual([
			{ path: "app/Compile.md", heading: "Starting a compile", quote: "A compile starts from   the Compile button." },
		]);
	});

	it("drops a heading or quote that isn't in the file, and keeps the file", async () => {
		const anchors = await checkAnchors(snapshot(), [{ path: "./app/Compile.md", heading: "Nowhere", quote: "Not in the note." }]);
		expect(anchors).toEqual([{ path: "app/Compile.md" }]);
	});

	it("drops an anchor whose file isn't in the snapshot", async () => {
		const dir = snapshot();
		const outside = tempFolder();
		write(outside, { "Secret.md": NOTE });
		symlinkSync(join(outside, "Secret.md"), join(dir, "Link.md"));

		const anchors = await checkAnchors(dir, [
			{ path: "app/Missing.md", quote: "A compile starts" },
			{ path: "../Compile.md" },
			{ path: join(outside, "Secret.md") },
			{ path: "Link.md" },
			{ path: "app" },
			{ heading: "Starting a compile" },
		]);
		expect(anchors).toEqual([]);
	});

	it("drops every anchor when there is no snapshot to check against", async () => {
		const problems = await checkProblems(null, [{ problem: "Broken", anchors: [{ path: "app/Compile.md" }] }]);
		expect(problems).toEqual([{ text: "Broken", anchors: [] }]);
	});

	it("checks each problem's anchors and keeps problems without any", async () => {
		const problems = await checkProblems(snapshot(), [
			{ problem: " From the model ", anchors: [{ path: "app/Compile.md", heading: "## Starting a compile" }] },
			"Build failed",
			{ problem: "" },
		]);
		expect(problems).toEqual([
			{ text: "From the model", anchors: [{ path: "app/Compile.md", heading: "## Starting a compile" }] },
			{ text: "Build failed", anchors: [] },
		]);
	});
});
