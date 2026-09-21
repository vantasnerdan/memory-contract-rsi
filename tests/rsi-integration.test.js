import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { apply } from "../lib/index.js";

process.env.PYTHONPATH = resolve("cli/src") + (process.env.PYTHONPATH ? ":" + process.env.PYTHONPATH : "");
function fakeResponse(questions) {
	const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
		if (q.type === "noul") return [id, { type: "noul", noul: 0.01 }];
		const keys = q.type === "score" ? q.criteria.map((_, i) => String(i)) : Object.keys(q.criteria);
		const preferred = { alignment: "aligned", preservation: "preserved", outcome_support: "insufficient", mechanism: "tool-reliability", evidence_status: "observed", signal: "mixed", destination: "tool-fix", witness: "e0", ambiguity: "ambiguous", generality: "local", sufficiency: "mixed", operation: "other-artifact", target_section: "none", novelty: "covered" };
		const proposed = id.startsWith("policy_") ? "covered" : preferred[id] ?? "equivalent";
		const selected = q.type === "score" ? keys.at(-1) : keys.includes(proposed) ? proposed : keys[0];
		const answer = { type: q.type, probabilities: Object.fromEntries(keys.map(k => [k, k === selected ? 1 : 0])), confidence: 1 };
		if (q.type === "score") Object.assign(answer, { score: Number(selected), legend: Object.fromEntries(keys.map(k => [k, q.criteria[Number(k)]])) });
		else answer.choice = selected;
		return [id, answer];
	}));
	return new Response(JSON.stringify({ model: "jev-fixture", answers, usage: { input_tokens: 100, output_tokens: 40 } }));
}

test("registered plugin + real Python CLI complete revision-bound RSI lifecycle", async t => {
	const base = mkdtempSync(join(tmpdir(), "rsi-lifecycle-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const tools = new Map(), sent = [];
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	globalThis.fetch = async (url, options) => {
		assert.equal(url, "https://api.typesafe.ai/v1/systemone");
		assert.equal(options.headers.Authorization, "Bearer mock-key");
		const body = JSON.parse(options.body); sent.push(body);
		return fakeResponse(body.questions);
	};
	apply({ tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} }, get: name => name === "tools" ? { get: toolName => tools.get(toolName) ?? (toolName === "read" ? { name: "read" } : undefined) } : name === "credentials" ? { resolve: async () => ({ value: "mock-key" }), describe: async () => ({ configured: true }) } : undefined }, { base, memoryBin: "/no-memory-executable", pythonBin: "python3", timeoutMs: 10000, typesafeEnabled: true });
	const exec = { agent: { id: "test-session" }, signal: new AbortController().signal };
	const call = async (name, action, request = {}) => JSON.parse((await tools.get(name).execute({ action, request: JSON.stringify(request), no_git: true }, exec)).result);
	const template = await call("memory_plan", "review", { template_id: "general" });
	const request = template.create_example;
	delete request.action; request.plan_id = "lifecycle";
	const created = await call("memory_plan", "create", request);
	assert.equal(created.policy_preflight.status, "assessed", JSON.stringify(created.policy_preflight));
	assert.equal(sent.length, 1);
	const receipt = created.policy_preflight.receipt;
	const persisted = await call("memory_rsi", "read", { id: receipt.id });
	assert.equal(persisted.artifact.freshness.stale, false);
	assert.equal(persisted.artifact.data.response.model, "jev-fixture");
	assert.doesNotMatch(readFileSync(receipt.path, "utf8"), /mock-key/);
	const prep = await call("memory_rsi", "prepare", { plan_ids: ["lifecycle"] });
	await call("memory_rsi", "reflect", { plan_id: "lifecycle", lesson: "Hypothesis only; work is still pending." });
	const nextBody = prep.policy.body + "\nPrefer a focused contract over unrelated procedure.\n";
	await call("memory_rsi", "propose", { proposal_id: "focused", body: nextBody, reason: "Fixture candidate, not a demonstrated optimization", expected_revision: prep.policy.revision, plan_ids: ["lifecycle"] });
	const evaluation = await call("memory_rsi", "evaluate", { proposal_id: "focused" });
	assert.equal(evaluation.status, "assessed");
	assert.equal(evaluation.interpretation.disposition, "needs-outcome-evidence");
	const promotion = { proposal_id: "focused", evaluation_id: evaluation.receipt.id, expected_revision: prep.policy.revision, review_note: "Testing explicit preview/apply lifecycle only; no claim of empirical improvement" };
	const preview = await call("memory_rsi", "promote", promotion);
	assert.equal(preview.applied, false);
	assert.equal((await call("memory_policy", "read")).revision, prep.policy.revision);
	assert.equal((await call("memory_rsi", "promote", { ...promotion, apply: true })).applied, true);
	assert.equal((await call("memory_policy", "read")).body, nextBody);
	assert.equal((await call("memory_plan", "read", { plan_id: "lifecycle" })).revision, created.revision);
	assert.equal((await call("memory_rsi", "read", { id: receipt.id })).artifact.freshness.stale, true);
	await assert.rejects(call("memory_rsi", "evaluate", { proposal_id: "focused" }), /Stale proposal/);
	await call("memory_policy", "rollback", { revision: prep.policy.revision, expected_revision: preview.proposed_revision, actor: "agent", reason: "Fixture rollback restores baseline" });
	assert.equal((await call("memory_policy", "read")).body, prep.policy.body);
	const listed = await call("memory_rsi", "list");
	assert.equal(listed.artifacts.length, 4);
	assert.equal(sent.length, 2);
});

test("real CLI learns selected session evidence and links a whole-section proposal", async t => {
	const base = mkdtempSync(join(tmpdir(), "rsi-learning-lifecycle-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const tools = new Map(), listeners = new Map(), effects = [], sent = [];
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; for (const dispose of effects) dispose?.(); });
	globalThis.fetch = async (_url, options) => { const body = JSON.parse(options.body); sent.push(body); return fakeResponse(body.questions); };
	apply({ tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} }, on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); }, effect: effect => { effects.push(effect()); }, get: name => name === "tools" ? { get: toolName => tools.get(toolName) ?? (toolName === "read" ? { name: "read" } : undefined) } : name === "credentials" ? { resolve: async () => ({ value: "mock-key" }), describe: async () => ({ configured: true }) } : undefined }, { base, memoryBin: "/no-memory-executable", pythonBin: "python3", timeoutMs: 10000, typesafeEnabled: true, rsiTelemetryEnabled: true });
	const agent = { id: "learning-session" }, exec = { agent, signal: new AbortController().signal };
	const call = async (name, action, request = {}, context = exec) => JSON.parse((await tools.get(name).execute({ action, request: JSON.stringify(request), no_git: true }, context)).result);
	const template = await call("memory_plan", "review", { template_id: "general" });
	const request = template.create_example; delete request.action; request.plan_id = "learning";
	const created = await call("memory_plan", "create", request);
	listeners.get("tools/result")({ agent, callId: "call-1", rootCallId: "call-1", name: "read", arguments: { password: "NEVER-PERSIST" } }, { isError: true, error: { message: "NEVER-PERSIST", info: { code: "FS_NOT_FOUND" } } });
	listeners.get("tools/result")({ agent, callId: "call-2", rootCallId: "call-2", name: "read" }, { isError: false, value: "NEVER-PERSIST" });
	const observed = await call("memory_rsi", "observe", { plan_id: "learning", context_note: "Agent-selected hypothesis: a missing-path lookup followed by a corrected read. Could be an expected probe, not necessarily misuse." });
	assert.equal(observed.network_called, false);
	assert.equal(observed.telemetry.totals.total, 2);
	assert.equal(sent.length, 1);
	assert.doesNotMatch(readFileSync(observed.receipt.path, "utf8"), /NEVER-PERSIST|mock-key/);
	const other = await call("memory_rsi", "observe", {}, { agent: { id: "different-session" }, signal: exec.signal });
	assert.equal(other.telemetry.totals.total, 0);
	assert.notEqual(other.telemetry.source.session_marker, observed.telemetry.source.session_marker);
	await assert.rejects(call("memory_rsi", "observe", { session_id: "different-session" }), /Unknown RSI fields/);
	const corpus = await call("memory_rsi", "corpus", { kind: "observations", limit: 10 });
	assert.equal(corpus.sources.length, 2);
	let fields = { kind: "observations", source_ids: [observed.receipt.id], max_calls: 4 };
	const maps = new Set();
	for (let turn = 0; turn < 32; turn++) {
		const page = await call("memory_rsi", "mine", fields);
		for (const saved of page.receipts) { assert.equal(saved.status, "assessed"); maps.add(saved.id); }
		if (!page.resume) { assert.equal(page.status, "complete"); break; }
		fields = page.resume;
		assert.ok(turn < 31, "mapping must make resumable progress");
	}
	assert.ok(maps.size > 0);
	const beforeCached = sent.length;
	const reused = await call("memory_rsi", "mine", { kind: "observations", source_ids: [observed.receipt.id], max_calls: 1 });
	assert.equal(reused.cache_hits, maps.size);
	assert.equal(reused.calls, 0);
	assert.equal(sent.length, beforeCached);
	const insight = await call("memory_rsi", "reduce", { artifact_ids: [...maps] });
	assert.equal(insight.status, "complete");
	assert.equal(insight.issues[0].destination, "tool-fix");
	assert.equal(insight.issues[0].independent_source_count, 1);
	const focused = await call("memory_rsi", "read", { id: insight.receipt.id, issue_index: 0 });
	assert.equal(focused.issue.destination, "tool-fix");
	assert.equal(focused.artifact.id, insight.receipt.id);
	assert.ok(focused.assessment.assessment.response.answers);
	await assert.rejects(call("memory_rsi", "read", { id: insight.receipt.id, issue_index: 999 }), /existing insight issue/);
	const prep = await call("memory_rsi", "prepare", { plan_ids: ["learning"], insight_ids: [insight.receipt.id] });
	assert.equal(prep.issues[0].id, insight.receipt.id);
	const section = prep.sections.find(item => item.level === 2);
	const proposal = await call("memory_rsi", "propose", { proposal_id: "section-fixture", edits: [{ operation: "replace", section_ids: [section.section_id], reason: "Exercise a coherent section revision preserving all original obligations", body: section.body.replace(section.title, section.title + " and clarity") }], expected_revision: prep.policy.revision, plan_ids: ["learning"], source_artifact_ids: [insight.receipt.id], reason: "Lifecycle fixture, not a real policy recommendation" });
	assert.equal(proposal.artifact.data.edit_summary[0].operation, "replace");
	assert.equal(proposal.artifact.bindings.artifacts[0].id, insight.receipt.id);
	const evaluation = await call("memory_rsi", "evaluate", { proposal_id: "section-fixture" });
	assert.equal(evaluation.status, "assessed");
	assert.equal(sent.at(-1).state.issues[0].id, insight.receipt.id);
	assert.equal((await call("memory_plan", "read", { plan_id: "learning" })).revision, created.revision);
	assert.equal((await call("memory_policy", "read")).revision, prep.policy.revision);
	assert.equal((await call("memory_rsi", "clear_signals")).persisted_artifacts_removed, false);
});

test("registered default audit discovers live prompt, configured AGENTS and active skills without applying edits", async t => {
	const base = mkdtempSync(join(tmpdir(), "rsi-auto-audit-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const instructionFile = join(base, "AGENTS.md");
	writeFileSync(instructionFile, "Project guidance: run focused verification.\n");
	const tools = new Map(), promptSections = [], sent = [];
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	globalThis.fetch = async (_url, options) => { const body = JSON.parse(options.body); sent.push(body); return fakeResponse(body.questions); };
	const skills = {
		async snapshot(options) { assert.equal(options.scope.id, "audit-session"); return { complete: true, skills: [{ name: "review", description: "Review guidance", invocation: { modelInvocable: true, userInvocable: true }, source: "runtime", provider: "fixture" }] }; },
		async get(name) { return { name, description: "Review guidance", invocation: { modelInvocable: true, userInvocable: true }, source: "runtime", provider: "fixture", content: "Inspect ownership before proposing edits.", path: join(base, "skills/review/SKILL.md") }; },
	};
	const systemPrompt = {
		section(section) { promptSections.push(section); },
		async assemble() { return { sections: [{ name: "persona", text: "System guidance: preserve authority." }, ...promptSections.map(section => ({ name: section.name, text: typeof section.text === "function" ? section.text() : section.text }))], contexts: [{ name: "sandbox:policy", text: "Workspace write." }], tools: [], variables: {} }; },
	};
	apply({
		tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt,
		get: name => name === "tools" ? { get: toolName => tools.get(toolName) ?? (toolName === "read" ? { name: "read" } : undefined) }
			: name === "skills" ? skills
				: name === "credentials" ? { resolve: async () => ({ value: "mock-key" }), describe: async () => ({ configured: true }) }
					: undefined,
	}, { base, memoryBin: "/no-memory-executable", pythonBin: "python3", instructionFiles: [instructionFile], timeoutMs: 10000, typesafeEnabled: true, rsiInstructionDiscoveryEnabled: true });
	const exec = { agent: { id: "audit-session", session: { header: { cwd: base } } }, signal: new AbortController().signal };
	const call = async (name, action, request = {}, noGit = true) => JSON.parse((await tools.get(name).execute({ action, request: JSON.stringify(request), no_git: noGit }, exec)).result);
	const before = await call("memory_policy", "read");
	const audit = await call("memory_rsi", "audit", {}, false);
	const after = await call("memory_policy", "read");
	assert.equal(audit.discovery.complete, true, JSON.stringify(audit.discovery));
	assert.deepEqual(audit.discovery.requested_classes, ["system", "agents", "skill"]);
	assert.equal(audit.proposal_guidance.automatic_apply, false);
	assert.equal(audit.publication.mode, "local-only");
	assert.equal(audit.receipt.persistence.git.status, "disabled");
	assert.equal(audit.receipt.persistence.git.committed, false);
	assert.equal(audit.receipt.persistence.git.pushed, false);
	assert.equal(audit.receipt.persistence.local_only.pattern, "/rsi-local-audit-*.md");
	assert.match(audit.receipt.id, /^local-audit-/);
	assert.equal(readFileSync(join(base, "shared/efforts/.gitignore"), "utf8"), "/rsi-local-audit-*.md\n");
	assert.equal(after.revision, before.revision);
	assert.equal(readFileSync(instructionFile, "utf8"), "Project guidance: run focused verification.\n");
	assert.ok(sent.length >= 1 && sent.length <= 12);
	const remotelyAssessed = sent.flatMap(call => call.state.units ?? []).map(unit => unit.body).join("\n");
	assert.match(remotelyAssessed, /preserve authority/);
	assert.match(remotelyAssessed, /focused verification/);
	assert.match(remotelyAssessed, /Inspect ownership/);
	assert.equal(audit.coverage.content_mapping_complete, true);
	assert.equal(audit.coverage.whole_instruction_stack_reviewed, false);
	assert.equal(audit.interpretation.disposition, "needs-outcome-evidence");
	assert.doesNotMatch(JSON.stringify(sent), new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const persisted = await call("memory_rsi", "read", { id: audit.receipt.id });
	assert.equal(persisted.artifact.data.discovery.local_details.includes("capture manifest"), true);
	const captureManifest = await call("memory_rsi", "read", { id: audit.capture.manifest.id });
	assert.equal(captureManifest.artifact.data.discovery.routes[1].targets[0].path, instructionFile);
	const effortDir = join(base, "shared/efforts");
	const localAudits = readdirSync(effortDir).filter(name => /^rsi-local-audit-.*\.md$/u.test(name));
	assert.ok(localAudits.length >= audit.capture.snapshots.length + audit.stages.length + 2);
	assert.ok(localAudits.every(name => statSync(join(effortDir, name)).size <= 128 * 1024));
	assert.ok(audit.capture.snapshots.every(snapshot => snapshot.id.startsWith("local-audit-")));
});
