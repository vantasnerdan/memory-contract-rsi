import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstructionSourceDiscovery, discoveryAssessmentSummary } from "../lib/rsi-source-discovery.js";

function fixture(t, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "rsi-sources-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const instruction = join(root, "AGENTS.md");
	writeFileSync(instruction, options.instructions ?? "Run focused tests.\n<!-- memory-rsi:policy:begin -->\nManaged copy.\n<!-- memory-rsi:policy:end -->\n");
	const skills = {
		async snapshot(view) {
			assert.equal(view.scope?.id, "agent-1");
			assert.equal(view.cwd, root);
			return { complete: true, skills: [{ name: "coding", description: "Coding guidance", invocation: { modelInvocable: true, userInvocable: true }, source: "project-dsh", provider: "filesystem" }] };
		},
		async get(name) {
			assert.equal(name, "coding");
			return { name, description: "Coding guidance", whenToUse: "When changing code", invocation: { modelInvocable: true, userInvocable: true }, source: "project-dsh", provider: "filesystem", content: "Inspect before editing and run tests.", path: join(root, "skills/coding/SKILL.md") };
		},
	};
	const ctx = {
		systemPrompt: {
			async assemble(view) {
				assert.equal(view.scope?.id, "agent-1");
				return {
					sections: [
						{ name: "persona", text: options.system ?? "You are a coding agent." },
						{ name: "tool:memory-rsi", text: "Proactive audit guidance.\n\n## Editable memory policy\nCANONICAL COPY MUST NOT BE DUPLICATED" },
					],
					contexts: [{ name: "sandbox:policy", text: "Workspace write is active." }], tools: [], variables: {},
				};
			},
		},
		get: name => name === "skills" ? skills : undefined,
	};
	const exec = { agent: { id: "agent-1", session: { header: { cwd: root } } }, signal: new AbortController().signal };
	return { root, instruction, ctx, exec };
}

test("automatic discovery snapshots current prompt, configured AGENTS files and active skills", async t => {
	const f = fixture(t);
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })(f.exec);
	assert.deepEqual(result.members.map(member => member.kind), ["system", "system", "agents", "skill"]);
	const system = result.members.filter(member => member.kind === "system").map(member => member.body).join("\n");
	assert.match(system, /You are a coding agent/);
	assert.match(system, /Proactive audit guidance/);
	assert.doesNotMatch(system, /CANONICAL COPY MUST NOT BE DUPLICATED|Workspace write is active/);
	assert.match(result.members.find(member => member.kind === "agents").body, /Run focused tests/);
	assert.doesNotMatch(result.members.find(member => member.kind === "agents").body, /Managed copy/);
	assert.equal(result.members.find(member => member.kind === "skill").body, "Inspect before editing and run tests.");
	assert.equal(result.discovery.complete, true);
	assert.equal(result.discovery.classes[1].managed_policy_mirrors_excluded, 1);
	const skillCoverage = result.discovery.classes.find(item => item.kind === "skill");
	assert.equal(skillCoverage.body_projection, "exact-skill-content");
	assert.equal(skillCoverage.routing_text_in_body, false);
	assert.equal(result.discovery.routes[1].targets[0].path, f.instruction);
	assert.match(result.discovery.routes[2].targets[0].path, /skills\/coding\/SKILL\.md$/);
	const remoteSummary = discoveryAssessmentSummary(result.discovery);
	assert.equal(remoteSummary.complete, true);
	assert.equal(remoteSummary.classes.find(item => item.kind === "skill").body_projection, "exact-skill-content");
	assert.doesNotMatch(JSON.stringify(remoteSummary), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("system members retain exact renderPrompt separators across section boundaries", async t => {
	const f = fixture(t);
	f.ctx.systemPrompt.assemble = async () => ({ sections: [{ name: "a", text: "A" }, { name: "b", text: "B" }], contexts: [], tools: [], variables: {} });
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })(f.exec);
	const members = result.members.filter(member => member.kind === "system");
	assert.equal(members.map(member => member.body).join(""), "A\n\nB");
	const coverage = result.discovery.classes.find(item => item.kind === "system");
	assert.equal(coverage.original_assembled_bytes, Buffer.byteLength("A\n\nB"));
	assert.equal(coverage.admitted_assembled_bytes, Buffer.byteLength("A\n\nB"));
});

test("automatic discovery retains admitted critical members in full without prefix clipping", async t => {
	const body = "x".repeat(50000);
	const f = fixture(t, { system: body });
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })(f.exec);
	const system = result.members.find(member => member.id === "section:persona");
	const coverage = result.discovery.classes.find(item => item.kind === "system");
	assert.equal(system.body, body);
	assert.equal(Buffer.byteLength(system.body), Buffer.byteLength(body));
	assert.equal(coverage.truncated_members, 0);
	assert.equal(coverage.source_complete, true);
	assert.equal(result.discovery.complete, true);
});

test("unmanaged system and AGENTS bytes preserve whitespace exactly", async t => {
	const system = "   PROMPT\n\n\n\nTAIL   \n";
	const instructions = "   FIRST\n\n\n\nSECOND   \n";
	const f = fixture(t, { system, instructions });
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })(f.exec);
	assert.equal(result.members.find(member => member.id === "section:persona").body, system);
	assert.equal(result.members.find(member => member.kind === "agents").body, instructions);
	assert.equal(result.discovery.complete, true);
});

test("missing configured instruction files remain explicit discovery errors", async t => {
	const f = fixture(t);
	const missing = join(f.root, "missing-AGENTS.md");
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [missing], rsiInstructionDiscoveryEnabled: true })(f.exec);
	assert.equal(result.members.some(source => source.kind === "agents"), false);
	const agents = result.discovery.classes.find(item => item.kind === "agents");
	assert.equal(agents.complete, false);
	assert.equal(agents.errors[0].code, "ENOENT");
});

test("automatic discovery requires separate operator consent and an invoking agent", async t => {
	const f = fixture(t);
	await assert.rejects(createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction] })(f.exec), /operator must set rsiInstructionDiscoveryEnabled/);
	await assert.rejects(createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })({ signal: f.exec.signal }), /requires the current invoking agent/);
});

test("skills include only complete model-invocable winners", async t => {
	const f = fixture(t);
	const loaded = [];
	const summaries = [
		{ name: "model-skill", description: "model", invocation: { modelInvocable: true, userInvocable: true }, source: "runtime", provider: "fixture" },
		{ name: "user-only", description: "user", invocation: { modelInvocable: false, userInvocable: true }, source: "runtime", provider: "fixture" },
	];
	const service = {
		async snapshot() { return { complete: true, skills: summaries }; },
		async get(name) { loaded.push(name); return { ...summaries.find(item => item.name === name), content: `${name} body` }; },
	};
	f.ctx.get = name => name === "skills" ? service : undefined;
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [], rsiInstructionDiscoveryEnabled: true })(f.exec);
	assert.deepEqual(loaded, ["model-skill"]);
	assert.match(result.members.find(source => source.kind === "skill").body, /model-skill body/);
	assert.doesNotMatch(result.members.find(source => source.kind === "skill").body, /user-only/);
	assert.equal(result.discovery.classes.find(item => item.kind === "skill").user_only_excluded, 1);
	service.get = async name => ({ ...summaries.find(item => item.name === name), content: "" });
	const missingBody = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [], rsiInstructionDiscoveryEnabled: true })(f.exec);
	assert.equal(missingBody.discovery.classes.find(item => item.kind === "skill").errors[0].code, "SKILL_BODY_UNAVAILABLE");
	service.snapshot = async () => ({ complete: false, skills: summaries });
	loaded.length = 0;
	const incomplete = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [], rsiInstructionDiscoveryEnabled: true })(f.exec);
	assert.equal(loaded.length, 0);
	assert.equal(incomplete.members.some(source => source.kind === "skill"), false);
	assert.equal(incomplete.discovery.classes.find(item => item.kind === "skill").errors[0].code, "CATALOG_INCOMPLETE");
});

test("invalid UTF-8 instruction files are omitted rather than silently repaired", async t => {
	const f = fixture(t);
	writeFileSync(f.instruction, Buffer.from([0xff, 0xfe, 0xfd]));
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })(f.exec);
	const agents = result.discovery.classes.find(item => item.kind === "agents");
	assert.equal(result.members.some(source => source.kind === "agents"), false);
	assert.equal(agents.errors[0].code, "SOURCE_INVALID_UTF8");
});

test("oversized or malformed managed instruction files fail closed", async t => {
	const f = fixture(t);
	const discover = () => createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })(f.exec);
	writeFileSync(f.instruction, "x".repeat(128 * 1024 + 1));
	let result = await discover();
	assert.equal(result.discovery.classes.find(item => item.kind === "agents").errors[0].code, "SOURCE_TOO_LARGE");
	writeFileSync(f.instruction, "Owner text\n<!-- memory-rsi:policy:begin -->\nunterminated");
	result = await discover();
	assert.equal(result.discovery.classes.find(item => item.kind === "agents").errors[0].code, "MANAGED_BLOCK_MALFORMED");
});

test("malformed managed blocks in system sections are omitted before disclosure", async t => {
	const f = fixture(t, { system: "Owner prompt\n<!-- memory-rsi:policy:begin -->\nMANAGED COPY WITHOUT END" });
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })(f.exec);
	const system = result.members.find(source => source.kind === "system");
	const coverage = result.discovery.classes.find(item => item.kind === "system");
	assert.doesNotMatch(system.body, /MANAGED COPY WITHOUT END|Owner prompt/);
	assert.equal(coverage.complete, false);
	assert.equal(coverage.errors[0].code, "MANAGED_BLOCK_MALFORMED");
});

test("proposal routes include only assessed instruction files", async t => {
	const f = fixture(t);
	const missing = join(f.root, "missing-AGENTS.md");
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction, missing], rsiInstructionDiscoveryEnabled: true })(f.exec);
	const route = result.discovery.routes.find(item => item.kind === "agents");
	assert.deepEqual(route.targets.map(target => target.path), [f.instruction]);
	assert.deepEqual(route.managed_policy_targets.map(target => target.path), [f.instruction]);
	assert.equal(result.discovery.classes.find(item => item.kind === "agents").errors[0].code, "ENOENT");
});

test("configured file and error manifests remain bounded and visibly incomplete", async t => {
	const f = fixture(t);
	const paths = Array.from({ length: 1000 }, (_, index) => join(f.root, `missing-${index}.md`));
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: paths, rsiInstructionDiscoveryEnabled: true })(f.exec);
	const agents = result.discovery.classes.find(item => item.kind === "agents");
	assert.equal(agents.configured_files_total, 1000);
	assert.equal(agents.configured_files_scanned, 32);
	assert.equal(agents.configured_files_omitted, 968);
	assert.equal(agents.complete, false);
	assert.ok(agents.errors.some(error => error.code === "MEMBER_LIMIT"));
	assert.ok(Buffer.byteLength(JSON.stringify(result.discovery)) < 64 * 1024);
});

test("provider error details are bounded before local persistence", async t => {
	const f = fixture(t);
	f.ctx.systemPrompt.assemble = async () => { throw new Error("x".repeat(100_000)); };
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })(f.exec);
	const detail = result.discovery.classes.find(item => item.kind === "system").errors[0].detail;
	assert.ok(Buffer.byteLength(detail) <= 512);
	assert.match(detail, /truncated/);
});

test("provider-controlled error codes never enter the remote assessment summary", async t => {
	const f = fixture(t);
	f.ctx.systemPrompt.assemble = async () => { throw Object.assign(new Error("local detail"), { code: "SECRET_TOKEN_SHOULD_NOT_LEAVE_HOST" }); };
	const result = await createInstructionSourceDiscovery(f.ctx, { instructionFiles: [f.instruction], rsiInstructionDiscoveryEnabled: true })(f.exec);
	const summary = discoveryAssessmentSummary(result.discovery);
	assert.equal(summary.classes.find(item => item.kind === "system").error_codes[0], "SOURCE_UNAVAILABLE");
	assert.doesNotMatch(JSON.stringify(summary), /SECRET_TOKEN/);
});
