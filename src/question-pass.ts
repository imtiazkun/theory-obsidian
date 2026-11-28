/**
 * The question pass before the compile proper (CMP-99 to CMP-105, CMP-109, CMP-110): its prompt, the shape of its
 * answer, the wording-only check, and what the report, the button and the hooks show of it. Plain functions with no
 * Obsidian dependency, so they can be tested. `startCompile` in `src/compile.ts` runs it.
 */
import type { CompileAgent, CompileReport, Question, Revision } from "./compile";
import type { TokenUsage } from "./costs";
import { type DiffFile, fileSides, headingLevels, isNote } from "./model-diff";
import type { ChangedRule } from "./rule-map";
import { findRules } from "./rule-count";

/** Whether the pending revisions change what the code must do, in the pass's own word (CMP-99). */
export type CodeChange = "some" | "none";

/** The question pass of one compile, as its report keeps it (CMP-99). */
export interface QuestionPassRecord {
	/** `running` while it runs; `answered` once it gave its answer; else how it ended without one (CMP-104). */
	state: "running" | "answered" | "failed" | "cancelled";
	/** "some" or "none" (CMP-99), once answered. */
	changesCode?: CodeChange;
	/** The pass's one sentence on why. */
	why?: string;
	/** True when it said "none" and the change is wording only, so the compile proper didn't run (CMP-109). */
	skipped?: boolean;
	/** The pass's tokens in four parts (REP-56). They count towards the compile's cost, at the pass's own model. */
	tokens?: TokenUsage | number;
	/** The Check row's agent, model and effort it ran with (CFG-46). */
	agent?: CompileAgent;
	model?: string;
	effort?: string;
}

const ANCHOR_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string", description: "Model file path, relative to the model directory." },
		heading: { type: "string", description: "Heading the text sits under, as written." },
		quote: { type: "string", description: "Short text copied exactly from the note, Markdown included. One sentence at most." },
	},
	required: ["path"],
};

/** The question pass's answer (CMP-99): only questions, and "some" or "none" with one sentence why. It plans nothing. */
export const QUESTION_PASS_SCHEMA = {
	type: "object",
	properties: {
		questions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					question: { type: "string" },
					notes: {
						type: "array",
						items: { type: "string" },
						description: "Model file paths the question is about, relative to the model directory.",
					},
					anchors: {
						type: "array",
						description: "Where in the model the rule that needs updating sits: the file, its heading and a short quote of the rule.",
						items: ANCHOR_SCHEMA,
					},
				},
				required: ["question", "notes"],
			},
		},
		changesCode: {
			type: "string",
			enum: ["some", "none"],
			description: "Whether the pending revisions change what the code must do: some, or none.",
		},
		why: { type: "string", description: "One sentence on why." },
	},
	required: ["questions", "changesCode", "why"],
};

/** The pass's answer once read, or null when it isn't in the shape of QUESTION_PASS_SCHEMA. */
export interface QuestionPassAnswer {
	questions: (Omit<Question, "anchors"> & { anchors?: unknown })[];
	changesCode: CodeChange;
	why: string;
}

/** Reads the pass's structured answer (CMP-99). Anything else counts as no answer, so the pass failed (CMP-104). */
export function readQuestionPassAnswer(value: unknown): QuestionPassAnswer | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (!Array.isArray(v.questions) || (v.changesCode !== "some" && v.changesCode !== "none") || typeof v.why !== "string") return null;
	const questions = v.questions
		.filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === "object" && typeof (q as Record<string, unknown>).question === "string")
		.map((q) => ({
			question: q.question as string,
			notes: Array.isArray(q.notes) ? q.notes.filter((n): n is string => typeof n === "string") : [],
			...(q.anchors !== undefined ? { anchors: q.anchors } : {}),
		}));
	return { questions, changesCode: v.changesCode, why: v.why.trim() };
}

/** The changed rules as the pass's prompt lists them (CMP-92): each ID once, with the notes it is in. */
export function changedRulesText(rules: ChangedRule[]): string {
	if (rules.length === 0) return "No rule is added, removed or changed in these revisions.";
	const notes = new Map<string, string[]>();
	for (const rule of rules) notes.set(rule.id, [...(notes.get(rule.id) ?? []), rule.path]);
	return [...notes].map(([id, paths]) => `- ${id} (${paths.join(", ")})`).join("\n");
}

/**
 * The prompt of the question pass (CMP-99, CMP-100): the snapshot, the pending revisions, the changed rules and the
 * diff, and never the code. Its own prompt, apart from `compilePrompt`, because it plans nothing.
 */
export function questionPassPrompt(params: {
	snapshot: string;
	head: string;
	from: string | null;
	/** The repositories in the project folder, by name, so the pass knows which folders are model folders. */
	repos: string[];
	revisions: Revision[];
	rules: ChangedRule[];
	diff: string;
	/** True in a recompile: the revisions start where the earlier compile started (CMP-76). */
	recompile?: boolean;
}): string {
	const { snapshot, head, from, repos, revisions, rules, diff, recompile } = params;
	const revisionList = revisions.map((r) => `- ${r.hash.slice(0, 7)} ${r.date} ${r.author}: ${r.subject}`).join("\n");
	return `You are checking a theoretical model for questions, before it is compiled into a plan of work.

The theoretical model is a set of notes, written only by humans, that describes a software ecosystem: what it does and why. After you, a compile reads the model and the code, and plans the work that makes the code match the model. You read only the model, never the code, and you plan nothing. Your job is to find what the model leaves unclear, so the engineers can answer it in the model before the code is read.

The model at revision ${head} is in this directory, the current directory: ${snapshot}

${repos.length > 0 ? `Model folders named after a repository describe that repository only: ${repos.join(", ")}. Notes at the root of the model directory describe the whole system.` : "Notes at the root of the model directory describe the whole system."}

Rules:
- The model is read-only. Never create, edit, move or delete anything. You can only read, search and list.
- Ask only what the model leaves unclear, incomplete or contradictory: where these revisions say something two ways, leave out what the code needs to know, or contradict another note. Never guess.
- Never ask about the code, and never ask for a choice the model already made.
- Each question names the model files it is about in \`notes\`, with paths relative to the model directory, and has \`anchors\` pointing at the rule that needs updating: the model file, the heading it sits under, and a short quote of the rule copied exactly from the note.
- Leave \`questions\` empty when the model is clear.
- Set \`changesCode\` to "some" when these revisions change what the code must do, and to "none" when they don't, like a reworded reason or a fixed typo. Say why in \`why\`, in one sentence.
- Read only the lines you need of a file longer than 400 lines, and never read the same lines twice.
- Never touch GitHub.

## ${recompile ? "Revisions since the earlier compile started" : "Revisions since the last compile"}

${recompile ? "This compile plans again the work of an earlier compile, so the revisions start where that compile started." : from ? `Last compiled revision: ${from}` : "This is the first compile, so the whole model is new."}

${revisionList}

## Changed rules

Each rule these revisions add, remove or change, with the note it is in.

${changedRulesText(rules)}

## Changes to the model

Each change is shown with the whole section it sits in, from the heading above it to the next heading of the same or a higher level.

\`\`\`diff
${diff}
\`\`\`
`;
}

/**
 * What Compile anyway adds to the compile's prompt (CMP-102): the questions the pass asked, so Claude doesn't ask them
 * again. Nothing when there were none, as after CMP-109.
 */
export function askedQuestionsText(questions: Question[]): string {
	if (questions.length === 0) return "";
	const list = questions.map((q) => `- ${q.question}${q.notes.length > 0 ? ` (${q.notes.join(", ")})` : ""}`).join("\n");
	return `
## Questions already asked

A check before this compile asked these questions about the model. The engineer chose to compile anyway, before answering them. Don't ask them again. Where one leaves the work unclear, plan what is clear and say in \`problems\` what you left out because of it.

${list}
`;
}

/** The front matter of a note's lines, or "" when it has none. */
function frontMatter(lines: string[]): string {
	if (lines[0]?.trim() !== "---") return "";
	const end = lines.findIndex((line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."));
	return end > 0 ? lines.slice(0, end + 1).join("\n") : "";
}

/**
 * Each rule of a note with the text a wording change may not touch (CMP-110): its paragraph up to its last "Why:",
 * the whole paragraph when it has none, and whatever follows it before the next rule or heading, like the list
 * under CMP-94. Sorted, so two sides compare as lists.
 */
function ruleTexts(lines: string[]): string[] {
	const rules = findRules(lines.join("\n"));
	const levels = headingLevels(lines);
	return rules
		.map((rule, k) => {
			const next = rules[k + 1]?.line ?? lines.length;
			let end = next - 1;
			for (let i = rule.line + 1; i < next; i++) {
				if (levels[i] > 0) {
					end = i - 1;
					break;
				}
			}
			const paragraph = lines.slice(rule.line, rule.endLine + 1).join("\n");
			const why = paragraph.lastIndexOf("Why:");
			const fixed = (why >= 0 ? paragraph.slice(0, why) : paragraph).trimEnd();
			const after = lines.slice(rule.endLine + 1, end + 1).join("\n").trim();
			return `${rule.prefix}-${rule.number}\u0000${fixed}\u0000${after}`;
		})
		.sort();
}

/**
 * True when the plugin counts the pending revisions as wording only (CMP-110): no rule ID added or removed, no
 * front matter changed, and every change inside a rule after its "Why:". Changes outside every rule, like an
 * introduction, count as wording. Anything the plugin can't read as a note's text counts as more than wording: a
 * file that isn't a note, or a note renamed or moved, which may change the repository it describes (CMP-96).
 */
export function wordingOnly(files: DiffFile[]): boolean {
	for (const file of files) {
		if (!isNote(file.oldPath) && !isNote(file.newPath)) return false;
		if (file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath) return false;
		const text = fileSides(file);
		if (frontMatter(text.old) !== frontMatter(text.new)) return false;
		const before = ruleTexts(text.old);
		const after = ruleTexts(text.new);
		if (before.length !== after.length || before.some((rule, i) => rule !== after[i])) return false;
	}
	return true;
}

/** The notice and the summary when the pass has questions (CMP-101). */
export function questionsNotice(count: number): string {
	return `Claude has ${count} question${count === 1 ? "" : "s"} about the model. Answer them, commit, and compile again.`;
}

/** The report's summary when the pass said "none" for a wording-only change (CMP-109). */
export function nothingToChangeText(why: string): string {
	return `Claude found nothing in these revisions that the code must change: ${why}`;
}

/** The compile button and the report while the pass runs (UI-3). */
export const CHECKING_LABEL = "Checking the model…";
export const CHECKING_TOOLTIP = "Claude is reading the model for questions before it reads the code.";

/** True while a report's question pass runs, before the compile proper (UI-3). */
export function checkingModel(report: Pick<CompileReport, "status" | "questionPass"> | null | undefined): boolean {
	return report?.status === "running" && report.questionPass?.state === "running";
}

/**
 * Whether a report offers Compile anyway (CMP-102, CMP-109, REP-55): a compile the pass stopped with questions, or one
 * it ended as nothing to build. Hidden once a later compile moved the marker, Compile anyway's own included: the
 * revisions were compiled since, so it would plan them twice.
 */
export function compileAnywayShown(report: CompileReport, reports: CompileReport[]): boolean {
	const offered = report.status === "questions" || (report.status === "succeeded" && report.questionPass?.skipped === true);
	if (!offered) return false;
	const started = Date.parse(report.startedAt);
	return !reports.some((r) => r.id !== report.id && r.markerMoved === true && Date.parse(r.startedAt) > started);
}

/** The line the report shows under the summary for an answered pass that didn't end the compile by itself. */
export function questionPassLine(pass: QuestionPassRecord | undefined): string | null {
	if (pass?.state !== "answered" || pass.skipped || !pass.why) return null;
	return pass.changesCode === "none"
		? `Checked the model first. Claude found nothing the code must change: ${pass.why}`
		: `Checked the model first. The code must change: ${pass.why}`;
}
