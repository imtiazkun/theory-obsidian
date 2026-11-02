import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";

const prod = process.argv[2] === "production";
const outdir = "dist";

await mkdir(outdir, { recursive: true });
await copyFile("manifest.json", `${outdir}/manifest.json`);
await copyFile("styles.css", `${outdir}/styles.css`);

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
	],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: `${outdir}/main.js`,
});

if (prod) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
