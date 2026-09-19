import test from 'node:test';
import assert from 'node:assert/strict';
import { createRsi } from '../lib/rsi.js';
import { RECORD_BUDGET, retainedInput } from '../lib/rsi-assessment-data.js';

const policy = { body: 'Preserve permissions and reward outcomes.', revision: 'policy-v1' };
test('disabled oversized audits and trial reviews retain status and digest without credentials or oversized records', async () => {
	for (const action of ['audit', 'trial_review']) {
		let saved;
		const rsi = createRsi({ get() { throw new Error('must not resolve credentials'); } }, { typesafeEnabled: false }, {
			memory: async (_config, _argv, { stdin }) => {
				const req = JSON.parse(stdin);
				if (req.action === 'context') return JSON.stringify({ policy, plans: [{ plan_id: 'job', revision: 'job-v1', plan: { template: { template_id: 'general', revision: 'template-v1', content: {} }, task: { good: 'x'.repeat(160000) }, work_items: [] } }] });
				if (req.action === 'read') return JSON.stringify({ artifact: { id: 'result', kind: 'trial-results', revision: 'result-v1', freshness: { stale: false }, bindings: { policy_revision: policy.revision, plans: [] }, data: { schema: 'memory-rsi-trial/1', protocol: { procedure: 'x'.repeat(120000) }, results: [], summary: {}, limitations: [], review_note: 'reported' } } });
				saved = req;
				assert.ok(Buffer.byteLength(JSON.stringify(req.data)) < RECORD_BUDGET);
				return JSON.stringify({ artifact: { id: 'saved', revision: 'saved-v1' } });
			}, evaluate() { throw new Error('must not infer'); },
		});
		const request = action === 'audit' ? { sources: [{ id: 'project', kind: 'agents', scope: 'repo', body: 'Selected public guidance' }], plan_id: 'job' } : { results_id: 'result' };
		const result = await rsi.run(action, request, { no_git: true }, {});
		assert.equal(result.status, 'disabled');
		assert.equal(result.interpretation.disposition, 'not-assessed');
		assert.equal(saved.data.input_retained, false);
		assert.equal(saved.data.state, undefined);
		assert.match(saved.data.input_sha256, /^[a-f0-9]{64}$/);
	}
});

test('bounded input retention is status-independent and does not truncate Unicode into evidence', () => {
	const small = { body: '😀' }, questions = { q: { type: 'choice' } };
	assert.deepEqual(retainedInput(small, questions), { state: small, questions });
	const omitted = retainedInput({ body: '😀'.repeat(40000) }, questions);
	assert.equal(omitted.input_retained, false);
	assert.ok(omitted.input_bytes > 160000);
	assert.equal(omitted.state, undefined);
});
