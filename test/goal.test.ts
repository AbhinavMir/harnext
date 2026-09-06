import { describe, expect, it } from "vitest";
import { parseVerdict, runGoalLoop, type GoalRoundEvent } from "../src/goal.js";

describe("parseVerdict", () => {
	it("reads a bare JSON object", () => {
		expect(parseVerdict('{"done": true, "reason": "tests pass"}')).toEqual({ done: true, reason: "tests pass" });
	});

	it("reads a fenced object surrounded by prose", () => {
		const raw = 'Here is my call:\n```json\n{"done": false, "reason": "no test yet", "instruction": "add a test"}\n```\nthanks';
		expect(parseVerdict(raw)).toEqual({ done: false, reason: "no test yet", instruction: "add a test" });
	});

	it("drops an empty instruction", () => {
		expect(parseVerdict('{"done": true, "reason": "ok", "instruction": "  "}')).toEqual({ done: true, reason: "ok" });
	});

	it("throws when no verdict is present", () => {
		expect(() => parseVerdict("I think we are done maybe")).toThrow("valid");
	});
});

describe("runGoalLoop", () => {
	it("stops as soon as the director verifies the goal", async () => {
		const verdicts = [
			'{"done": false, "reason": "not built", "instruction": "build it"}',
			'{"done": false, "reason": "still failing", "instruction": "fix the test"}',
			'{"done": true, "reason": "the worker showed a passing test"}',
		];
		let call = 0;
		const events: GoalRoundEvent[] = [];
		const result = await runGoalLoop({ goal: "make the test pass", maxRounds: 10 }, {
			director: async () => verdicts[call++] as string,
			worker: async (instruction) => `did: ${instruction}`,
			onEvent: (event) => events.push(event),
		});

		expect(result.reached).toBe(true);
		expect(result.rounds).toBe(3);
		expect(result.transcript).toHaveLength(2);
		expect(result.transcript[0]).toEqual({ instruction: "build it", output: "did: build it" });
		expect(events.filter((event) => event.phase === "worker")).toHaveLength(2);
	});

	it("never reports success when the round cap is hit", async () => {
		let workerCalls = 0;
		const result = await runGoalLoop({ goal: "impossible", maxRounds: 3 }, {
			director: async () => '{"done": false, "reason": "nope", "instruction": "keep going"}',
			worker: async () => { workerCalls += 1; return "still trying"; },
		});

		expect(result.reached).toBe(false);
		expect(result.rounds).toBe(3);
		expect(workerCalls).toBe(3);
		expect(result.reason).toContain("without a verified done verdict");
	});

	it("errors when the director gives no instruction and is not done", async () => {
		await expect(runGoalLoop({ goal: "x", maxRounds: 5 }, {
			director: async () => '{"done": false, "reason": "unclear"}',
			worker: async () => "unused",
		})).rejects.toThrow("no next instruction");
	});
});
