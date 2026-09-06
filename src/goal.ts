/** Goal loop: a director agent instructs a worker harness until the goal is verifiably reached. */

export interface GoalVerdict {
	done: boolean;
	reason: string;
	instruction?: string;
}

export interface GoalRoundEvent {
	round: number;
	phase: "verdict" | "worker";
	done: boolean;
	reason: string;
	instruction?: string;
	workerOutput?: string;
}

export interface GoalExchange {
	instruction: string;
	output: string;
}

export interface GoalResult {
	reached: boolean;
	rounds: number;
	reason: string;
	transcript: GoalExchange[];
}

export interface GoalLoopOptions {
	goal: string;
	maxRounds: number;
	truncateChars?: number;
}

export interface GoalLoopDeps {
	/** Run the director agent with a full judgement prompt. Returns its raw reply. */
	director(prompt: string): Promise<string>;
	/** Run the worker harness with one instruction. Returns its raw reply. */
	worker(instruction: string): Promise<string>;
	onEvent?(event: GoalRoundEvent): void;
}

const DEFAULT_TRUNCATE = 4000;

function truncate(text: string, limit: number): string {
	const trimmed = text.trim();
	if (limit <= 0 || trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}\n[harnext: ${trimmed.length - limit} characters truncated]`;
}

export function buildDirectorPrompt(goal: string, transcript: GoalExchange[], truncateChars = DEFAULT_TRUNCATE): string {
	const history = transcript.length === 0
		? "No instructions have been sent yet. This is the first round."
		: transcript.map((exchange, index) => [
			`## Round ${index + 1}`,
			`Instruction you sent:`,
			exchange.instruction.trim(),
			`Worker reply:`,
			truncate(exchange.output, truncateChars),
		].join("\n")).join("\n\n");
	return [
		"You are the goal director. You drive a separate worker agent toward one goal.",
		"You cannot edit files yourself. The worker does the work. You judge and instruct.",
		"",
		"GOAL:",
		goal.trim(),
		"",
		"CONVERSATION SO FAR:",
		history,
		"",
		"Decide if the goal is FULLY and VERIFIABLY reached from the worker's own output.",
		"Do not assume success. Require concrete evidence in the worker reply (a passing test,",
		"a command result, the exact artifact the goal asks for). Partial progress is not done.",
		"",
		"Reply with ONLY one JSON object and nothing else:",
		'{"done": true|false, "reason": "<one sentence citing the evidence>", "instruction": "<the next concrete instruction to the worker>"}',
		"",
		'When "done" is false you MUST provide a specific "instruction" for the next step.',
		'When "done" is true, omit "instruction" or leave it empty.',
	].join("\n");
}

export function parseVerdict(raw: string): GoalVerdict {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
	const candidates = fenced === null ? [] : [fenced[1] as string];
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
	for (const candidate of candidates) {
		let parsed: unknown;
		try { parsed = JSON.parse(candidate); } catch { continue; }
		if (typeof parsed !== "object" || parsed === null) continue;
		const record = parsed as Record<string, unknown>;
		if (typeof record.done !== "boolean") continue;
		return {
			done: record.done,
			reason: typeof record.reason === "string" ? record.reason : "",
			...(typeof record.instruction === "string" && record.instruction.trim() !== "" ? { instruction: record.instruction } : {}),
		};
	}
	throw new Error(`Director did not return a valid {\"done\": ...} verdict. Raw reply:\n${raw.trim().slice(0, 500)}`);
}

export async function runGoalLoop(options: GoalLoopOptions, deps: GoalLoopDeps): Promise<GoalResult> {
	if (options.maxRounds < 1) throw new Error("maxRounds must be at least 1");
	const transcript: GoalExchange[] = [];
	for (let round = 1; round <= options.maxRounds; round += 1) {
		const verdict = parseVerdict(await deps.director(buildDirectorPrompt(options.goal, transcript, options.truncateChars)));
		deps.onEvent?.({ round, phase: "verdict", done: verdict.done, reason: verdict.reason, ...(verdict.instruction === undefined ? {} : { instruction: verdict.instruction }) });
		if (verdict.done) return { reached: true, rounds: round, reason: verdict.reason, transcript };
		if (verdict.instruction === undefined) throw new Error("Director declared the goal not done but gave no next instruction");
		const output = await deps.worker(verdict.instruction);
		transcript.push({ instruction: verdict.instruction, output });
		deps.onEvent?.({ round, phase: "worker", done: false, reason: verdict.reason, instruction: verdict.instruction, workerOutput: output });
	}
	return {
		reached: false,
		rounds: options.maxRounds,
		reason: `Stopped after ${options.maxRounds} rounds without a verified done verdict`,
		transcript,
	};
}
