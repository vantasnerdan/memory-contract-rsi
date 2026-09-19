#!/usr/bin/env node
// Deterministic, targeted defect replays. Not an unbiased accuracy benchmark or
// an experiment showing policy-induced agent improvement. No network/credentials.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseline = process.argv[2];
if (!baseline) throw new Error('Usage: node scripts/measure-rsi-regressions.mjs /absolute/baseline-checkout');
const current = resolve(import.meta.dirname, '..');
const load = (root, file) => import(pathToFileURL(resolve(root, file)).href);
function evaluationAnswers() {
	const values = Object.fromEntries(['reward_orientation', 'generality', 'synthesis', 'maintenance'].map(id => [id, { type: 'score', score: 2, confidence: 0.95 }]));
	return { ...values, preservation: { type: 'choice', choice: 'preserved', confidence: 0.95 }, boundary_erosion: { type: 'noul', noul: 0.01 }, outcome_support: { type: 'choice', choice: 'supported', confidence: 0.95 }, case_0: { type: 'choice', choice: 'candidate', confidence: 0.95 } };
}
async function measure(root) {
	const rubric = await load(root, 'lib/rsi-rubric.js');
	const learning = await load(root, 'lib/rsi-learning-rubric.js');
	const data = await load(root, 'lib/rsi-learning-data.js');
	const observations = [];
	const record = (id, observed, check) => observations.push({ id, observed, expected_behavior_observed: check(observed) });
	const plan = { plan_id: 'fixture', template: { template_id: 'coding', revision: 'v1', content: {} }, task: {}, work_items: [{ id: 'work', title: 'Fix', owner: 'fixture', requirement_ids: ['lsp'], status: 'pending', evidence: [], exceptions: [{ id: 'no-lsp', requirement_id: 'lsp', reason: 'No LSP server available', alternative: 'AST and focused checks', reviews: [{ verdict: 'accepted', note: 'Suitable substitute; not an LSP claim' }] }] }] };
	record('accepted-exception-visible', rubric.contractState({ plan, revision: 'fixture-v1' }).work_items[0].exceptions?.[0]?.reviews?.at(-1)?.verdict ?? 'omitted', value => value === 'accepted');
	for (const [id, mutate] of [
		['insufficient-comparison-abstains', a => { a.case_0.choice = 'insufficient'; }],
		['uncertain-baseline-preference-abstains', a => { a.case_0.choice = 'baseline'; a.case_0.confidence = 0.2; }],
		['equivalent-comparison-not-advantage', a => { a.case_0.choice = 'equivalent'; }],
		['poor-generality-needs-revision', a => { a.generality.score = 0; }],
		['uniform-distribution-not-confidence', a => { a.case_0.confidence = 1; a.case_0.probabilities = { candidate: 0.25, baseline: 0.25, equivalent: 0.25, insufficient: 0.25 }; }],
	]) {
		const a = evaluationAnswers(); mutate(a);
		record(id, rubric.interpretEvaluation(a, 1, 'old', 'new').disposition, value => value !== 'candidate-for-review');
	}
	const features = [{ source_key: 'plan:task', report_digest: 'report-a', source_family_keys: ['plan:task'] }, { source_key: 'observation:session', report_digest: 'report-b', source_family_keys: ['observation:session', 'plan:task'] }];
	record('linked-plan-observation-one-family', data.independentSources(features), value => value === 1);
	const group = { mechanism: 'evidence', counts: { evidence_status: { observed: 2 }, signals: { failure: 2 }, independent_source_count: 2 }, coverage: { strata_represented: 1, strata_total: 1 }, witnesses: [], meaning: 'synthetic controlled report' };
	const answers = Object.fromEntries(Object.entries({ destination: 'policy', operation: 'rewrite', sufficiency: 'contradicted', generality: 'cross-task', target_section: 'section', novelty: 'covered' }).map(([id, choice]) => [id, { type: 'choice', choice, confidence: 0.95 }]));
	record('contradicted-rewrite-investigates', learning.interpretGroup(group, { status: 'assessed', response: { answers } }, [{ id: 'section', heading: 'Evidence', revision: 'v1' }]).operation, value => value === 'investigate');
	const control = evaluationAnswers(); control.boundary_erosion.noul = 0.99;
	record('control-boundary-concern-preserved', rubric.interpretEvaluation(control, 1, 'old', 'new').disposition, value => value === 'human-review-required');
	record('control-supported-review-still-possible', rubric.interpretEvaluation(evaluationAnswers(), 1, 'old', 'new').disposition, value => value === 'candidate-for-review');
	return observations;
}
const before = await measure(resolve(baseline)), after = await measure(current);
const report = { schema: 'memory-rsi-targeted-regressions/1', baseline_commit: '1c42c79808b1dfa8a9827af06d75e3b04ded9cbe',
	measurement: 'Deterministic pure-function behavior on eight targeted reproduced defects and two preserved controls. Cases selected from this review, not held-out or independent task samples.',
	before_passed: before.filter(c => c.expected_behavior_observed).length, after_passed: after.filter(c => c.expected_behavior_observed).length, total: before.length,
	cases: before.map((entry, index) => ({ id: entry.id, before: entry.observed, after: after[index].observed, before_expected: entry.expected_behavior_observed, after_expected: after[index].expected_behavior_observed })),
	policy_improvement_demonstrated: false, limitation: 'Mechanism regression evidence only, not evaluator calibration, general policy quality, statistical significance or improved autonomous-agent task outcomes.' };
console.log(JSON.stringify(report, null, 2));
if (after.some(c => !c.expected_behavior_observed)) process.exitCode = 1;
