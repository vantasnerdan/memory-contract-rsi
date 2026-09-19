import test from "node:test";
import assert from "node:assert/strict";
import { registerContracts } from "../lib/contracts.js";

// The registered production callback in lib/index.js uses this exact prefix bound.
const clip = text => text.length > 100000 ? `${text.slice(0, 100000)}\n…(truncated at 100000 characters; narrow the query)` : text;
async function create(saved, preflight) {
	const tools = [];
	registerContracts({ tools: { register: tool => tools.push(tool) } }, { timeoutMs: 1000 }, {
		memory: async () => JSON.stringify(saved), clip, output: { schema: { type: "string" } },
		rsi: { preflight: async () => { if (preflight instanceof Error) throw preflight; return preflight; } },
	});
	return (await tools[0].execute({ action: "create", request: "{}" }, {})).result;
}
function saved(size = 110000) {
	return { path: "/memory/shared/plans/large.md", revision: "plan-v1", persistence: { saved: true, commit: "skipped", reason: "no_git" }, plan: { plan_id: "large", task: { good: "x".repeat(size) } }, validation: { valid: true, complete: false, work_items: [] } };
}
function preflight(status = "assessed") {
	return { status, reason: status === "unavailable" ? "Input too large; no inference" : "Coaching only", receipt: { id: "preflight-exact", revision: "assessment-v1", path: "/memory/shared/rsi/preflight-exact.json", bindings: { policy_revision: "policy-v1", plans: [{ plan_id: "large", revision: "plan-v1" }] }, freshness: { stale: false }, persistence: { saved: true } }, interpretation: { disposition: status === "assessed" ? "review-conflict" : "not-assessed", permission_effect: "none", achievement_credit: "none-before-outcomes" }, coverage: { instruction_layers: "canonical-only", omitted_layers: ["skills"] } };
}
for (const status of ["assessed", "unavailable", "disabled"]) {
	test(`oversized plan creation retains valid JSON and complete small ${status} preflight`, async () => {
		const input = saved(), coaching = preflight(status);
		const text = await create(input, coaching), result = JSON.parse(text);
		assert.ok(text.length <= 100000);
		assert.equal(result.plan.plan_id, "large");
		assert.equal(result.revision, input.revision);
		assert.equal(result.path, input.path);
		assert.deepEqual(result.persistence, input.persistence);
		assert.deepEqual(result.policy_preflight, coaching);
		assert.equal(result.details_omitted, true);
		assert.ok(result.omitted_fields.includes("plan.task"));
		assert.match(result.reason, /not.*complete|omission/i);
	});
}

test("oversized preflight preserves receipt, coverage and adverse disposition rather than slicing JSON", async () => {
	const coaching = preflight();
	coaching.response = { model: "jev-test", answers: { huge: "x".repeat(120000) }, usage: { input_tokens: 11, output_tokens: 7 }, elapsedMs: 9 };
	const text = await create(saved(), coaching), result = JSON.parse(text);
	assert.ok(text.length <= 100000);
	assert.equal(result.policy_preflight.status, "assessed");
	assert.equal(result.policy_preflight.interpretation.disposition, "review-conflict");
	assert.deepEqual(result.policy_preflight.receipt, coaching.receipt);
	assert.deepEqual(result.policy_preflight.coverage, coaching.coverage);
	assert.equal(result.policy_preflight.response.model, "jev-test");
	assert.deepEqual(result.policy_preflight.response.usage, coaching.response.usage);
	assert.equal(result.policy_preflight.response.answers, undefined);
	assert.ok(result.omitted_fields.includes("policy_preflight.response.answers"));
});

test("preflight attachment failure stays visible for an oversized saved plan", async () => {
	const result = JSON.parse(await create(saved(), new Error("Simulated persistence failure")));
	assert.equal(result.policy_preflight.status, "unavailable");
	assert.match(result.policy_preflight.reason, /Plan saved/);
	assert.equal(result.revision, "plan-v1");
});

test("small create response keeps the existing complete contract result", async () => {
	const input = saved(20), coaching = preflight();
	assert.deepEqual(JSON.parse(await create(input, coaching)), { ...input, policy_preflight: coaching });
});
