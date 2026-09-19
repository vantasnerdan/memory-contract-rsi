import test from "node:test";
import assert from "node:assert/strict";
import { assessmentConfident, contractState, evaluationQuestions, interpretEvaluation, preflightQuestions, interpretPreflight } from "../lib/rsi-rubric.js";

function typedAnswer(question, selected) {
	if (question.type === "noul") return { type: "noul", noul: 0.01 };
	const keys = question.type === "score" ? question.criteria.map((_, index) => String(index)) : Object.keys(question.criteria);
	const winner = question.type === "score" ? keys.at(-1) : selected;
	const answer = { type: question.type, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === winner ? 1 : 0])) };
	return question.type === "score" ? { ...answer, score: Number(winner), legend: Object.fromEntries(keys.map(key => [key, question.criteria[Number(key)]])) } : { ...answer, choice: winner };
}
function evaluation(count = 1) {
	return Object.fromEntries(Object.entries(evaluationQuestions(count)).map(([id, question]) => [id, typedAnswer(question, id === "preservation" ? "preserved" : id === "outcome_support" ? "supported" : "candidate")]));
}
const interpret = (answers, count = 1) => interpretEvaluation(answers, count, "Baseline requirements.", "Clearer requirements.");
function setChoice(answer, selected) {
	answer.choice = selected;
	answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities).map(key => [key, key === selected ? 1 : 0]));
}
function entry(verdicts = []) {
	return { revision: "plan-v1", plan: { plan_id: "example", template: { template_id: "coding", revision: "template-v1", content: { achievements: [{ id: "lsp", description: "Use LSP or justify an exception" }] } }, task: { title: "Fix a parser", purpose: "Restore behavior", good: "Regression reproduced and fixed" }, work_items: [{ id: "work", title: "Fix", owner: "agent", requirement_ids: ["lsp"], status: "pending", evidence: [], exceptions: [{ id: "no-lsp", requirement_id: "lsp", reason: "The language server is unavailable.", alternative: "Use AST navigation and regression tests.", reported_by: "agent", reported_at: "2026-09-19T00:00:00Z", reviews: verdicts.map(verdict => ({ verdict, note: "Reviewed the capability and alternative", reviewed_by: "reviewer", reviewed_at: "2026-09-19T01:00:00Z" })) }] }] } };
}

for (const verdicts of [[], ["accepted"], ["rejected"], ["accepted", "rejected"], ["rejected", "accepted"]]) {
	test(`preflight retains exception provenance and latest review: ${verdicts.join("/") || "unreviewed"}`, () => {
		const source = entry(verdicts), snapshot = structuredClone(source);
		const projected = contractState(source);
		const exception = projected.work_items[0].exceptions[0];
		assert.equal(exception.latest_review, verdicts.at(-1) ?? "unreviewed");
		assert.deepEqual(exception.reviews, source.plan.work_items[0].exceptions[0].reviews);
		assert.equal(exception.reason, source.plan.work_items[0].exceptions[0].reason);
		assert.equal(exception.alternative, source.plan.work_items[0].exceptions[0].alternative);
		assert.equal(exception.requirement_id, "lsp");
		assert.equal(exception.reported_by, "agent");
		assert.equal(projected.work_items[0].status, undefined);
		assert.equal(projected.work_items[0].evidence, undefined);
		assert.match(projected.exception_provenance, /not.*achievement/i);
		assert.deepEqual(source, snapshot);
	});
}

test("refreshing preflight can observe a newly recorded capability resolution without changing pinned requirements", () => {
	const source = entry(["accepted"]), absent = structuredClone(source);
	absent.plan.work_items[0].exceptions = [];
	assert.notDeepEqual(contractState(source), contractState(absent));
	assert.deepEqual(contractState(source).template, contractState(absent).template);
	assert.deepEqual(contractState(source).work_items[0].requirement_ids, ["lsp"]);
	const outcomes = contractState(source, { outcomes: true });
	assert.deepEqual(outcomes.work_items[0].exceptions, source.plan.work_items[0].exceptions);
	assert.equal(outcomes.work_items[0].status, "pending");
	assert.match(preflightQuestions().alignment.instructions, /latest_review/);
	assert.match(preflightQuestions([{ heading: "LSP" }]).policy_0.instructions, /unreviewed/);
});

test("a supported preference with complete confident comparison and quality remains advisory", () => {
	const result = interpret(evaluation());
	assert.equal(result.disposition, "candidate-for-review");
	assert.equal(result.comparison_coverage.candidate, 1);
	assert.equal(result.comparison_coverage.relevant_confident, 1);
	assert.equal(result.automatic_promotion, false);
	assert.equal(result.permission_effect, "none");
	assert.equal(result.achievement_credit, "none");
	assert.equal(result.improvement_claim, "not-demonstrated");
});

for (const selected of ["insufficient", "candidate", "baseline", "equivalent"]) {
	test(`diffuse ${selected} comparison is abstention, not positive evidence`, () => {
		const answers = evaluation();
		setChoice(answers.case_0, selected);
		answers.case_0.confidence = 0.1;
		const result = interpret(answers);
		assert.equal(result.disposition, "needs-comparison-evidence");
		assert.equal(result.comparison_coverage.uncertain, 1);
		assert.ok(result.reason_codes.includes("COMPARISON_UNCERTAIN"));
	});
}

test("confident insufficient and missing case answers cannot become candidate support", () => {
	const answers = evaluation(2);
	setChoice(answers.case_0, "insufficient");
	delete answers.case_1;
	const result = interpret(answers, 2);
	assert.equal(result.disposition, "needs-comparison-evidence");
	assert.equal(result.comparison_coverage.insufficient, 1);
	assert.equal(result.comparison_coverage.missing, 1);
	assert.equal(result.comparison_coverage.relevant_confident, 0);
});

test("partial coverage is visible even with a confident favorable case", () => {
	const answers = evaluation(2);
	setChoice(answers.case_1, "insufficient");
	const result = interpret(answers, 2);
	assert.equal(result.disposition, "needs-comparison-evidence");
	assert.equal(result.comparison_coverage.candidate, 1);
	assert.equal(result.comparison_coverage.total, 2);
});

test("zero cases and equivalent cases never demonstrate candidate advantage", () => {
	const empty = interpret(evaluation(0), 0);
	assert.equal(empty.disposition, "needs-comparison-evidence");
	assert.ok(empty.reason_codes.includes("NO_COMPARISON_CASES"));
	const answers = evaluation(); setChoice(answers.case_0, "equivalent");
	const result = interpret(answers);
	assert.equal(result.disposition, "retain-baseline");
	assert.ok(result.reason_codes.includes("NO_CANDIDATE_ADVANTAGE"));
});

test("unchanged policy cannot earn an improvement interpretation from contradictory preference", () => {
	const result = interpretEvaluation(evaluation(), 1, "Same policy.", "Same policy.");
	assert.equal(result.disposition, "retain-baseline");
	assert.ok(result.reason_codes.includes("UNCHANGED_POLICY"));
});

for (const id of ["reward_orientation", "generality", "synthesis", "maintenance"]) {
	for (const concern of ["low-score", "uncertain", "missing"]) {
		test(`${id} ${concern} is not ignored when a comparison favors the candidate`, () => {
			const answers = evaluation();
			if (concern === "low-score") { answers[id].score = 0; answers[id].probabilities = { 0: 1, 1: 0, 2: 0 }; }
			if (concern === "uncertain") answers[id].confidence = 0.1;
			if (concern === "missing") delete answers[id];
			const result = interpret(answers);
			assert.equal(result.disposition, "revise-candidate");
			assert.ok(result.reason_codes.includes("QUALITY_REVIEW_NEEDED"));
			assert.ok(result.revision_opportunities.some(item => item.id === id));
		});
	}
}

test("a confident regression and boundary concern dominate favorable quality and evidence", () => {
	const answers = evaluation(2); setChoice(answers.case_1, "baseline");
	assert.equal(interpret(answers, 2).disposition, "retain-baseline");
	answers.boundary_erosion.noul = 0.8;
	assert.equal(interpret(answers, 2).disposition, "human-review-required");
});

test("unsupported outcomes stay unsupported even when all semantic preferences favor the candidate", () => {
	const answers = evaluation(); setChoice(answers.outcome_support, "insufficient");
	assert.equal(interpret(answers).disposition, "needs-outcome-evidence");
});

test("tied choice distribution cannot become clear alignment from an inconsistent high confidence", () => {
	const answers = Object.fromEntries(Object.entries(preflightQuestions()).map(([id, question]) => [id, typedAnswer(question, "aligned")]));
	answers.alignment.probabilities = { aligned: 0.25, gaps: 0.25, conflict: 0.25, unknown: 0.25 };
	const result = interpretPreflight(answers);
	assert.equal(result.disposition, "strengthen-plan");
	assert.ok(result.opportunities.some(item => item.id === "policy-alignment"));
	assert.equal(answers.alignment.confidence, 1);
});

test("shared confidence heuristic requires a selected majority without inventing calibration", () => {
	const choice = { type: "choice", choice: "candidate", confidence: 0.6 };
	assert.equal(assessmentConfident(choice), true); // Legacy injected fixtures only; real transport requires probabilities.
	assert.equal(assessmentConfident({ ...choice, confidence: 0.59 }), false);
	assert.equal(assessmentConfident({ ...choice, confidence: 1.1 }), false);
	assert.equal(assessmentConfident({ ...choice, probabilities: {} }), false);
	assert.equal(assessmentConfident({ ...choice, probabilities: { candidate: 0.5, baseline: 0.5 } }), false);
	assert.equal(assessmentConfident({ ...choice, probabilities: { candidate: 0.26, baseline: 0.25, equivalent: 0.25, insufficient: 0.24 } }), false);
	assert.equal(assessmentConfident({ ...choice, probabilities: { candidate: 0.8, baseline: 0.2 } }), true);
	assert.equal(assessmentConfident({ ...choice, probabilities: { candidate: 0.8, baseline: 0.8 } }), false);
	assert.equal(assessmentConfident({ type: "score", confidence: 1, probabilities: { 0: 0, 1: 0.5, 2: 0.5 } }), false);
	assert.equal(assessmentConfident(undefined), false);
});

test("a favorable tied case distribution is uncertain without recalibrating raw confidence", () => {
	const answers = evaluation();
	answers.case_0.probabilities = { baseline: 0.25, candidate: 0.25, equivalent: 0.25, insufficient: 0.25 };
	const snapshot = structuredClone(answers);
	assert.equal(interpret(answers).disposition, "needs-comparison-evidence");
	assert.deepEqual(answers, snapshot);
});
