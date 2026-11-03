import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// Obsidian only exists inside the app, so tests get a small stub (TEST-7).
		alias: { obsidian: fileURLToPath(new URL("./test/obsidian-stub.ts", import.meta.url)) },
	},
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
		// Real git repositories in temporary folders take a moment.
		testTimeout: 20000,
	},
});
