import { INDEX_TEMPLATE, MODEL_INSTRUCTIONS, TEMPLATES_FOLDER } from "./templates";

export interface StarterFile {
	/** Path relative to the vault root. */
	path: string;
	/** Paths that count as this file, relative to the vault root and compared without case. */
	sameAs: string[];
	content: string;
}

/** The lines every vault's .gitignore must have (SET-8). */
export const GITIGNORE_LINES = [
	".DS_Store",
	".trash/",
	// Obsidian's settings, the plugin's build and its data with the compile reports. None of it is model.
	".obsidian/",
];

const INSTRUCTIONS = `Theoretical model is the textual representation of a software: what it does, why and in some cases how. It should be detailed enough that an AI can replicate a whole software following this and easy enough so that a new recruit can understand.

## Human Only
- Only humans write the model. AI may read it, but must never create, edit, move or delete anything in it.
- The model is the source of truth. When the code disagrees with the model, the code changes.
- If the model is unclear or contradicts itself, AI asks a question in the compile report. It never guesses, and never suggests new wording.

## Doctrine
- Use AI for ideation but always **write by hand.** The words should be yours.
- **Make important statements crude**. "A refund is reject after 30 days", not 'refunds are handled carefully'
- **One claim per sentence.** A failed compile can then point at exactly one claim.
- **Use firm words.** *Must*, *never* and *always* for rules, *may* for options. Avoid *should* and *usually*.
- **Say why.** A rule without a reason gets "improved" away.
- **Say what the system must not do.** Behaviour the model doesn't describe shouldn't exist in the code.
- **Keep headings stable and give rules IDs** (\`INV-3\`, \`AC-7\`). Failure pointers anchor to them. Retire an ID; never reuse it.
- **Mark what isn't built yet**.
- **Answer Claude's questions in the model**, not in chat.
- **One intent per commit**, and the commit message says why.
`;

/**
 * The starter files besides the .gitignore lines: everything Setup vault writes (SET-15). Setup and Create
 * missing files use this one list, and each skips a file that exists under any of its names.
 */
export function starterFiles(vaultName: string): StarterFile[] {
	return [
		{ path: "Index.md", sameAs: ["index.md"], content: `Manifesting ${vaultName}\n` },
		{ path: "Instructions.md", sameAs: ["instruction.md", "instructions.md"], content: INSTRUCTIONS },
		{ path: `${TEMPLATES_FOLDER}/index.md`, sameAs: [`${TEMPLATES_FOLDER}/index.md`], content: INDEX_TEMPLATE },
		{ path: `${TEMPLATES_FOLDER}/instructions.md`, sameAs: [`${TEMPLATES_FOLDER}/instructions.md`], content: MODEL_INSTRUCTIONS },
	];
}
