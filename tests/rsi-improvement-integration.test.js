import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { apply } from '../lib/index.js';

process.env.PYTHONPATH = resolve('cli/src') + (process.env.PYTHONPATH ? ':' + process.env.PYTHONPATH : '');
function response(questions) {
	return new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 100, output_tokens: 10 }, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
		const keys = Object.keys(q.criteria);
		const choice = id.startsWith('source_') ? 'coherent' : id.startsWith('pair_') ? 'compatible' : ({ validity: 'plausible', support: 'candidate', evidence: 'reviewable' }[id] ?? keys[0]);
		return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
	})) }));
}

test('registered audit and trial lifecycle persist exact sources through real CLI without policy edits', async t => {
	const base = mkdtempSync(join(tmpdir(), 'rsi-improvement-'));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const tools = new Map(), sent = [];
	const previous = globalThis.fetch;
	t.after(() => { globalThis.fetch = previous; });
	globalThis.fetch = async (_url, opts) => { const body = JSON.parse(opts.body); sent.push(body); return response(body.questions); };
	apply({ tools: { register: value => tools.set(value.name, value) }, systemPrompt: { section() {} }, get: name => name === 'credentials' ? { resolve: async () => ({ value: 'mock-private-key' }), describe: async () => ({ configured: true }) } : undefined },
		{ base, memoryBin: '/no-memory-executable', pythonBin: 'python3', timeoutMs: 10000, typesafeEnabled: true });
	const exec = { agent: { id: 'improvement-test' }, signal: new AbortController().signal };
	const call = async (action, request = {}) => JSON.parse((await tools.get('memory_rsi').execute({ action, request: JSON.stringify(request), no_git: true }, exec)).result);
	const preparation = await call('prepare', { plan_ids: [] });
	const baseline = preparation.policy;
	const audit = await call('audit', { sources: [{ id: 'project', kind: 'agents', scope: 'repository', body: 'Reward tested useful outcomes. Preserve permissions.' }] });
	assert.equal(audit.status, 'assessed');
	assert.equal(audit.interpretation.policy_changed, false);
	assert.equal((await call('read', { id: audit.receipt.id })).artifact.freshness.stale, false);
	assert.doesNotMatch(readFileSync(audit.receipt.path, 'utf8'), /mock-private-key/);
	await call('propose', { proposal_id: 'candidate', expected_revision: baseline.revision, plan_ids: [], body: baseline.body + '\nKeep related guidance coherent.\n', reason: 'Synthetic lifecycle fixture, not a real gain claim' });
	const environment = { agent_model: 'fixture-agent', tool_environment: 'fixture-tools-v1', max_tokens: 1000, max_steps: 10 };
	const registered = await call('trial_spec', { trial_id: 'paired', proposal_id: 'candidate', hypothesis: 'Synthetic mechanism check only', procedure: 'Fixed paired fixture runs with controlled environment, no model training', stopping_rule: 'Run the two declared cases once each; retain adverse results', environment,
		metrics: { outcome: 'Expected check passes', safety: 'Any unauthorized write', cost_unit: 'tokens' },
		cases: ['holdout', 'control'].map(split => ({ case_id: split, revision: 'sha256:' + (split === 'holdout' ? 'a' : 'b').repeat(64), split, family: split })) });
	assert.equal(registered.artifact.kind, 'trial-spec');
	const arm = (outcome, cost) => ({ status: 'observed', outcome, safety_violations: 0, cost, environment, evidence_refs: ['fixture:case-output'], note: 'Synthetic check result, not a real-agent behavior claim' });
	const report = await call('trial_results', { trial_id: registered.artifact.id, trial_revision: registered.artifact.revision, review_note: 'Unit fixture; no independent attestation',
		results: ['holdout', 'control'].map(case_id => ({ case_id, baseline: arm(false, 2), candidate: arm(true, 1) })) });
	assert.equal(report.artifact.data.summary.total.outcome.paired, 2);
	assert.equal(report.artifact.data.summary.total.outcome.delta_successes, 2);
	assert.equal(report.artifact.data.summary.total.safety.regressed_pairs, 0);
	assert.equal(sent.length, 1, 'trial registration/results are local only');
	const review = await call('trial_review', { results_id: report.artifact.id });
	assert.equal(review.status, 'assessed');
	assert.equal(review.interpretation.automatic_promotion, false);
	assert.equal(review.interpretation.disposition, 'reported-gain-for-review');
	const saved = (await call('read', { id: review.receipt.id })).artifact;
	assert.equal(saved.bindings.artifacts[0].revision, report.artifact.revision);
	assert.equal(saved.freshness.stale, false);
	assert.equal((await call('prepare', { plan_ids: [] })).policy.revision, baseline.revision);
	assert.equal(sent.length, 2);
	await assert.rejects(call('trial_results', { trial_id: registered.artifact.id, trial_revision: registered.artifact.revision, results: [], review_note: 'Try to replace the fixed report' }));
});
