import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// The real `obsidian` package has types only. Tests get a small stub instead.
		alias: { obsidian: fileURLToPath(new URL("./test/obsidian.ts", import.meta.url)) },
	},
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
		// Real git in temp folders is slower than plain unit tests.
		testTimeout: 20_000,
	},
});
