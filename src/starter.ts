export interface StarterFile {
	/** Path relative to the vault root. */
	path: string;
	/** Paths relative to the vault root that count as this file, compared without case. */
	sameAs: string[];
	content: string;
}

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

/** The first line of every model folder's instructions.md, and the starter text of its template. */
export const MODEL_INSTRUCTIONS =
	"The writing rules in [the root Instructions](../Instructions.md) apply here. Rules for Claude that apply only to this repository go below.\n";

/** The starter text of `_templates/index.md`. */
const INDEX_TEMPLATE = `## What this repository is

{{description}}

{{purpose}}

## Its place in the system

%% What it depends on, and what depends on it. Link the other repositories' index notes. %%

## What it does not do

%% What people might expect here but lives elsewhere, or nowhere. %%

## Notes

%% One line per note: the question it answers and its rule prefix. Concepts first, then the main flows, then UI and settings. %%

## Not built yet

%% The notes marked realized: false. %%
`;

export const INDEX_TEMPLATE_PATH = "_templates/index.md";
export const INSTRUCTIONS_TEMPLATE_PATH = "_templates/instructions.md";

/**
 * Everything Setup vault writes, besides the `.gitignore` lines. Setup and Create missing files
 * both use this one list, and skip any file that already exists under one of its names.
 */
export function starterFiles(vaultName: string): StarterFile[] {
	return [
		{ path: "Index.md", sameAs: ["Index.md"], content: `Manifesting ${vaultName}\n` },
		{ path: "Instructions.md", sameAs: ["Instructions.md", "instruction.md"], content: INSTRUCTIONS },
		{ path: INDEX_TEMPLATE_PATH, sameAs: [INDEX_TEMPLATE_PATH], content: INDEX_TEMPLATE },
		{ path: INSTRUCTIONS_TEMPLATE_PATH, sameAs: [INSTRUCTIONS_TEMPLATE_PATH], content: MODEL_INSTRUCTIONS },
	];
}
