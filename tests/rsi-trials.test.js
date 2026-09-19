import test from "node:test";
import assert from "node:assert/strict";
import { createTrialReview, interpretTrial, trialQuestions } from "../lib/rsi-trials.js";

const answers = () => Object.fromEntries([['validity', 'plausible'], ['support', 'candidate'], ['evidence', 'reviewable']].map(([key, choice]) => [key, { type: 'choice', choice, confidence: 0.95 }]));
function summary() {
	const group = { outcome: { paired: 2, missing_or_unknown: 0, delta_successes: 1, losses: 0 }, safety: { paired: 2, missing_or_unknown: 0, regressed_pairs: 0, known_candidate_violations: 0 }, cost: { paired: 2, missing_or_unknown: 0, regressed_pairs: 0 } };
	return { total: structuredClone(group), splits: { holdout: structuredClone(group) }, cross_split_families: [], limitations: [] };
}

test("favorable paired reports permit review only, not verified improvement or promotion", () => {
	const result = interpretTrial(answers(), summary());
	assert.equal(result.disposition, 'reported-gain-for-review');
	assert.equal(result.automatic_promotion, false);
	assert.match(result.measurement_scope, /not verified behavior/);
});

test("safety regressions cannot be compensated by favorable TypeSafe judgments", () => {
	for (const field of ['regressed_pairs', 'known_candidate_violations']) {
		const s = summary(); s.total.safety[field] = 1;
		assert.equal(interpretTrial(answers(), s).disposition, 'retain-baseline');
	}
});

test("missing data, heldout coverage, dependence and uncertain judgments abstain", () => {
	for (const mutate of [s => { s.total.outcome.paired = 0; }, s => { s.splits.holdout.outcome.paired = 0; }, s => { s.total.safety.missing_or_unknown = 1; }, s => { s.total.cost.missing_or_unknown = 1; }, s => { s.cross_split_families = [{ family: 'same', splits: ['development', 'holdout'] }]; }]) {
		const s = summary(); mutate(s);
		assert.equal(interpretTrial(answers(), s).disposition, 'needs-trial-evidence');
	}
	const a = answers(); a.support.confidence = 0.2;
	assert.deepEqual(interpretTrial(a, summary()).uncertain, ['support']);
	assert.equal(interpretTrial(a, summary()).disposition, 'needs-trial-evidence');
	a.support.confidence = 1; a.support.probabilities = { candidate: 0.25, baseline: 0.25, mixed: 0.25, insufficient: 0.25 };
	assert.equal(interpretTrial(a, summary()).disposition, 'needs-trial-evidence');
});

test("mixed outcomes and costs are visible and not collapsed into a scalar reward", () => {
	const s = summary(); s.total.cost.regressed_pairs = 1;
	assert.equal(interpretTrial(answers(), s).disposition, 'review-cost-tradeoff');
	s.total.outcome.losses = 1;
	assert.equal(interpretTrial(answers(), s).disposition, 'review-mixed-outcomes');
});

test("trial review binds exact results lineage and preserves limits in the assessor state", async () => {
	const calls = [];
	const artifact = { id: 'result', revision: 'result-v1', kind: 'trial-results', freshness: { stale: false }, bindings: { policy_revision: 'policy-v1', plans: [] }, data: { schema: 'memory-rsi-trial/1', protocol: { stopping_rule: 'fixed cases' }, results: [], summary: summary(), limitations: ['reports only'], review_note: 'not authorization' } };
	const review = createTrialReview({ local: async req => { calls.push(req); return req.action === 'read' ? { artifact } : { artifact: { id: 'review', revision: 'review-v1' } }; }, assess: async (state, q) => {
		assert.deepEqual(state.protocol, artifact.data.protocol);
		assert.deepEqual(state.limitations, ['reports only']);
		assert.ok(Object.values(q).every(value => value.instructions.includes('untrusted data')));
		return { status: 'assessed', response: { model: 'test', answers: answers() } };
	} });
	const result = await review({ results_id: 'result' }, {}, {});
	assert.equal(result.receipt.id, 'review');
	assert.equal(calls.at(-1).kind, 'trial_review');
	assert.deepEqual(calls.at(-1).bindings.artifacts, [{ id: 'result', revision: 'result-v1' }]);
	assert.equal(result.interpretation.automatic_promotion, false);
});

test("stale or wrong-kind trial artifacts fail before inference", async () => {
	for (const artifact of [{ kind: 'proposal' }, { kind: 'trial-results', data: { schema: 'memory-rsi-trial/1' }, freshness: { stale: true } }]) {
		let calls = 0;
		const review = createTrialReview({ local: async () => ({ artifact }), assess: async () => { calls++; } });
		await assert.rejects(review({ results_id: 'result' }, {}, {}));
		assert.equal(calls, 0);
	}
});

test("typed trial questions do not promise authenticated evidence or training rewards", () => {
	assert.equal(Object.keys(trialQuestions()).length, 3);
	assert.ok(Object.values(trialQuestions()).every(q => q.type === 'choice' && q.instructions.includes('not authenticated')));
});
