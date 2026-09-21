import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

export const SOURCE_DISCOVERY_VERSION = "memory-rsi-source-discovery/2";
const FILE_READ_BUDGET = 128 * 1024;
const MAX_MEMBER_BODY_BYTES = 128 * 1024;
const MAX_MEMBERS = 64;
const MAX_CONFIGURED_FILES = 32;
const MAX_ERROR_DETAILS = 64;
const MAX_ERROR_DETAIL_BYTES = 512;
const MAX_ROUTE_PATH_BYTES = 512;
const MAX_ROUTE_MANIFEST_BYTES = 6 * 1024;
const EDITABLE_POLICY_MARKER = "\n\n## Editable memory policy\n";
const MANAGED_POLICY_BEGIN = "<!-- memory-rsi:policy:begin -->";
const MANAGED_POLICY_END = "<!-- memory-rsi:policy:end -->";

const hash = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SAFE_ERROR_CODES = new Set(["SKILL_BODY_UNAVAILABLE", "CATALOG_INCOMPLETE", "EACCES", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG", "ENFILE", "ENOENT", "ENOTDIR", "EPERM", "ERROR_LIMIT", "MANAGED_BLOCK_MALFORMED", "MEMBER_LIMIT", "ROUTE_INVALID", "SERVICE_UNAVAILABLE", "SOURCE_INVALID_UTF8", "SOURCE_NOT_REGULAR", "SOURCE_TOO_LARGE", "SOURCE_UNAVAILABLE"]);
const code = error => SAFE_ERROR_CODES.has(error?.code) ? error.code : "SOURCE_UNAVAILABLE";
const boundedDetail = value => clipUtf8(String(value), MAX_ERROR_DETAIL_BYTES).text || "source detail omitted";
const errorView = (error, memberId) => ({ member_id: memberId, code: code(error), detail: boundedDetail(error instanceof Error ? error.message : error) });
function boundedErrors(errors) {
	if (errors.length <= MAX_ERROR_DETAILS) return errors.map(error => ({ ...error, detail: boundedDetail(error.detail) }));
	return [
		...errors.slice(0, MAX_ERROR_DETAILS - 1).map(error => ({ ...error, detail: boundedDetail(error.detail) })),
		{ member_id: "discovery-errors", code: "ERROR_LIMIT", detail: `${errors.length - MAX_ERROR_DETAILS + 1} additional discovery errors omitted` },
	];
}
function boundedTargets(targets) {
	const selected = [];
	let bytes = 2;
	for (const target of targets) {
		const size = Buffer.byteLength(JSON.stringify(target));
		if (bytes + size + (selected.length ? 1 : 0) > MAX_ROUTE_MANIFEST_BYTES) continue;
		selected.push(target);
		bytes += size + (selected.length > 1 ? 1 : 0);
	}
	return { selected, omitted: targets.length - selected.length };
}

function clipUtf8(value, maxBytes) {
	const totalBytes = Buffer.byteLength(value);
	if (totalBytes <= maxBytes) return { text: value, total_bytes: totalBytes, retained_bytes: totalBytes, truncated: false };
	if (maxBytes <= 0) return { text: "", total_bytes: totalBytes, retained_bytes: 0, truncated: true };
	const marker = `\n...[truncated; original UTF-8 bytes: ${totalBytes}]`;
	const markerBytes = Buffer.byteLength(marker);
	if (markerBytes > maxBytes) return { text: "", total_bytes: totalBytes, retained_bytes: 0, truncated: true };
	const payloadBudget = maxBytes - markerBytes;
	const points = [...value];
	let low = 0, high = points.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(points.slice(0, middle).join("")) <= payloadBudget) low = middle;
		else high = middle - 1;
	}
	const text = points.slice(0, low).join("") + marker;
	return { text, total_bytes: totalBytes, retained_bytes: Buffer.byteLength(text), truncated: true };
}

function stripManagedPolicyBlocks(value) {
	let body = value, count = 0, offset = 0;
	while (true) {
		const begin = body.indexOf(MANAGED_POLICY_BEGIN, offset);
		if (begin < 0) break;
		const end = body.indexOf(MANAGED_POLICY_END, begin + MANAGED_POLICY_BEGIN.length);
		if (end < 0) break;
		body = body.slice(0, begin) + body.slice(end + MANAGED_POLICY_END.length);
		count += 1;
		offset = begin;
	}
	return { body, count, malformed: body.includes(MANAGED_POLICY_BEGIN) || body.includes(MANAGED_POLICY_END) };
}

function readRegularText(path) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw Object.assign(new Error("instruction source is not a regular file"), { code: "SOURCE_NOT_REGULAR" });
		const limit = Math.min(stat.size, FILE_READ_BUDGET);
		const buffer = Buffer.alloc(limit);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, null);
			if (!count) break;
			length += count;
		}
		const truncated = stat.size > FILE_READ_BUDGET;
		let body;
		for (let trim = 0; trim <= (truncated ? 3 : 0); trim += 1) {
			try { body = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, Math.max(0, length - trim))); break; }
			catch (error) { if (trim === (truncated ? 3 : 0)) throw Object.assign(new Error(`instruction source is not valid UTF-8: ${error.message}`), { code: "SOURCE_INVALID_UTF8" }); }
		}
		return { body, truncated, total_bytes: stat.size };
	} finally { closeSync(fd); }
}

function collectClass({ id, kind, scope, members, expectedTotal = members.length, complete = true, errors = [], owner, workflow }) {
	const discovered = members.slice(0, MAX_MEMBERS);
	const allErrors = [...errors];
	if (members.length > discovered.length) allErrors.push({ member_id: id, code: "MEMBER_LIMIT", detail: `${members.length - discovered.length} additional source members omitted` });
	const accepted = [];
	for (const member of discovered) {
		const bodyBytes = Buffer.byteLength(member.body);
		if (bodyBytes > MAX_MEMBER_BODY_BYTES) {
			allErrors.push({ member_id: member.id, code: "SOURCE_TOO_LARGE", detail: `source member exceeds ${MAX_MEMBER_BODY_BYTES} bytes and was omitted rather than clipped` });
			continue;
		}
		accepted.push({
			id: member.id, class_id: id, kind, scope, body: member.body, revision: hash(member.body),
			metadata: { id: member.id, revision: hash(member.body), ...member.metadata },
		});
	}
	const routed = boundedTargets(accepted.map(member => {
		const original = discovered.find(candidate => candidate.id === member.id);
		return { member_id: member.id, ...original.route };
	}));
	const omittedMembers = Math.max(0, expectedTotal - accepted.length);
	const sourceComplete = complete && allErrors.length === 0 && omittedMembers === 0;
	return {
		members: accepted,
		coverage: {
			kind, source_id: id, members_total: expectedTotal, members_included: accepted.length,
			omitted_members: omittedMembers, route_limited_members: routed.omitted, truncated_members: 0,
			body_bytes: accepted.reduce((sum, member) => sum + Buffer.byteLength(member.body), 0),
			source_complete: sourceComplete, routing_complete: routed.omitted === 0,
			complete: sourceComplete && routed.omitted === 0, errors: boundedErrors(allErrors),
		},
		route: {
			source_id: id, kind, owner, workflow, apply: "explicit-review-only", targets: routed.selected,
		},
	};
}

function promptMember(entry, assembly) {
	const rawBody = renderPrompt({ ...assembly, sections: [entry] });
	let body = rawBody;
	const managed = stripManagedPolicyBlocks(body);
	body = managed.body;
	let canonicalPolicySuffixExcluded = false;
	if (entry.name === "tool:memory-rsi") {
		const marker = body.indexOf(EDITABLE_POLICY_MARKER.trimStart());
		if (marker >= 0) {
			body = body.slice(0, marker);
			canonicalPolicySuffixExcluded = true;
		}
	}
	return {
		id: `section:${entry.name}`,
		body,
		managed_mirrors_excluded: managed.count, managed_marker_malformed: managed.malformed,
		metadata: { form: "section", name: entry.name, raw_revision: hash(rawBody), raw_bytes: Buffer.byteLength(rawBody), ...(canonicalPolicySuffixExcluded ? { canonical_policy_suffix_excluded: true } : {}), ...(managed.count ? { managed_policy_mirrors_excluded: managed.count } : {}) },
		route: { type: "system-prompt-section", name: entry.name },
	};
}

async function discoverSystemPrompt(ctx, exec) {
	try {
		const assembly = await ctx.systemPrompt.assemble({ agent: exec.agent, scope: exec.agent, ...(exec.signal ? { signal: exec.signal } : {}) });
		const allSections = assembly.sections ?? [];
		const rendered = allSections.slice(0, MAX_MEMBERS).map(entry => promptMember(entry, assembly));
		const mirrors = rendered.reduce((sum, member) => sum + member.managed_mirrors_excluded, 0);
		const errors = rendered.filter(member => member.managed_marker_malformed).map(member => ({ member_id: member.id, code: "MANAGED_BLOCK_MALFORMED", detail: "managed policy markers are unbalanced in the rendered section; this section was omitted" }));
		if (allSections.length > MAX_MEMBERS) errors.push({ member_id: "system-prompt", code: "MEMBER_LIMIT", detail: `${allSections.length - MAX_MEMBERS} additional system-prompt sections omitted` });
		const admitted = rendered.filter(member => !member.managed_marker_malformed && member.body.trim());
		// renderPrompt joins nonempty rendered sections with one blank line. Prefixing
		// every admitted section after the first retains those exact assembly bytes
		// without inventing a source-level judgment for a synthetic separator member.
		const members = admitted.map((member, index) => index === 0 ? member : {
			...member, body: `\n\n${member.body}`, metadata: { ...member.metadata, assembly_separator_prefix_bytes: 2 },
		});
		const result = collectClass({
			id: "system-current", kind: "system",
			scope: "System-prompt sections reassembled for the invoking agent at audit time. Canonical policy and managed AGENTS mirrors are represented separately.",
			members, complete: errors.length === 0, errors, owner: "system-prompt-providers", workflow: "provider-or-composition-review",
		});
		const originalPrompt = renderPrompt(assembly);
		result.coverage.sections_total = allSections.length;
		result.coverage.sections_scanned = rendered.length;
		result.coverage.managed_policy_mirrors_excluded = mirrors;
		result.coverage.original_assembled_bytes = Buffer.byteLength(originalPrompt);
		result.coverage.admitted_assembled_bytes = members.reduce((total, member) => total + Buffer.byteLength(member.body), 0);
		result.coverage.assembly_byte_scope = "Exact rendered assembly after explicit canonical-policy/managed-mirror deduplication; excluded content is represented by the separate canonical-policy member.";
		return result;
	} catch (error) {
		return collectClass({ id: "system-current", kind: "system", scope: "Current rendered system prompt", members: [], expectedTotal: 1, complete: false, errors: [errorView(error, "system-prompt")], owner: "system-prompt-providers", workflow: "provider-or-composition-review" });
	}
}

function discoverInstructionFiles(config) {
	const members = [], errors = [], managedPolicyTargets = [];
	const configuredFiles = config.instructionFiles ?? [];
	const scannedFiles = configuredFiles.slice(0, MAX_CONFIGURED_FILES);
	let managedMirrors = 0;
	for (const [index, path] of scannedFiles.entries()) {
		const memberId = typeof path === "string" ? `instruction-file:${hash(path).slice(7, 19)}` : `instruction-file:${index}`;
		try {
			if (typeof path !== "string" || !path || Buffer.byteLength(path) > MAX_ROUTE_PATH_BYTES) throw Object.assign(new Error("configured instruction-file route is invalid or too long"), { code: "ROUTE_INVALID" });
			const route = { type: "instruction-file", path, unmanaged_workflow: "file-owner-review", managed_policy_workflow: "memory_policy-sync" };
			const read = readRegularText(path);
			if (read.truncated) throw Object.assign(new Error(`instruction source exceeds ${FILE_READ_BUDGET} bytes; select a narrower explicit source`), { code: "SOURCE_TOO_LARGE" });
			const stripped = stripManagedPolicyBlocks(read.body);
			if (stripped.malformed) throw Object.assign(new Error("instruction source has unbalanced memory-rsi managed policy markers"), { code: "MANAGED_BLOCK_MALFORMED" });
			managedMirrors += stripped.count;
			if (stripped.count) managedPolicyTargets.push({ type: "managed-policy-mirror", path, workflow: "memory_policy-sync" });
			if (!stripped.body.trim()) continue;
			members.push({ id: memberId, body: stripped.body, metadata: { raw_revision: hash(read.body), raw_bytes: read.total_bytes, managed_policy_mirrors_excluded: stripped.count }, route });
		} catch (error) { errors.push(errorView(error, memberId)); }
	}
	if (configuredFiles.length > scannedFiles.length) errors.push({ member_id: "instruction-files", code: "MEMBER_LIMIT", detail: `${configuredFiles.length - scannedFiles.length} additional configured instruction files omitted` });
	const boundedManaged = boundedTargets(managedPolicyTargets);
	if (boundedManaged.omitted) errors.push({ member_id: "managed-policy-mirrors", code: "MEMBER_LIMIT", detail: `${boundedManaged.omitted} managed policy owner routes omitted by the route budget` });
	const result = collectClass({
		id: "agents-configured", kind: "agents",
		scope: "Unmanaged content from operator-configured AGENTS-like instruction files. Managed memory-rsi policy mirrors are excluded and remain owned by memory_policy sync.",
		members, expectedTotal: members.length, complete: errors.length === 0,
		errors, owner: "instruction-file-owners", workflow: "file-owner-review-or-memory-policy-sync",
	});
	result.route.managed_policy_targets = boundedManaged.selected;
	result.coverage.managed_policy_targets_omitted = boundedManaged.omitted;
	result.coverage.configured_files_total = configuredFiles.length;
	result.coverage.configured_files_scanned = scannedFiles.length;
	result.coverage.configured_files_omitted = configuredFiles.length - scannedFiles.length;
	result.coverage.managed_policy_mirrors_excluded = managedMirrors;
	return result;
}

async function discoverSkills(ctx, exec) {
	const service = ctx.get?.("skills");
	if (!service) return collectClass({ id: "skills-active", kind: "skill", scope: "Active model-invocable skills", members: [], expectedTotal: 1, complete: false, errors: [{ member_id: "skills-registry", code: "SERVICE_UNAVAILABLE", detail: "skills service is unavailable" }], owner: "skill-providers", workflow: "skill-owner-review" });
	const options = { scope: exec.agent, ...(exec.agent.session?.header?.cwd ? { cwd: exec.agent.session.header.cwd } : {}), ...(exec.signal ? { signal: exec.signal } : {}) };
	try {
		const snapshot = await service.snapshot(options);
		const summaries = snapshot.skills ?? [];
		const effective = summaries.filter(summary => summary.invocation?.modelInvocable === true);
		if (snapshot.complete !== true) {
			const result = collectClass({ id: "skills-active", kind: "skill", scope: "Active model-invocable skills", members: [], expectedTotal: effective.length || 1, complete: false, errors: [{ member_id: "skills-registry", code: "CATALOG_INCOMPLETE", detail: "skill catalog discovery was incomplete; no skill bodies were assessed" }], owner: "skill-providers", workflow: "skill-owner-review" });
			result.coverage.skills_total = summaries.length;
			result.coverage.model_invocable_total = effective.length;
			return result;
		}
		const members = [], errors = [];
		for (const summary of effective.slice(0, MAX_MEMBERS)) {
			try {
				const skill = await service.get(summary.name, options);
				if (!skill || typeof skill.content !== "string" || !skill.content.trim()) throw Object.assign(new Error("skill body is unavailable"), { code: "SKILL_BODY_UNAVAILABLE" });
				members.push({
					id: `skill:${skill.name}`, body: skill.content,
					metadata: { name: skill.name, description: skill.description, when_to_use: skill.whenToUse ?? null, source: skill.source, provider: skill.provider },
					route: { type: "skill", name: skill.name, source: skill.source, provider: skill.provider, ...(skill.path ? { path: skill.path } : {}) },
				});
			} catch (error) { errors.push(errorView(error, `skill:${summary.name}`)); }
		}
		const result = collectClass({
			id: "skills-active", kind: "skill", scope: "Active model-invocable global, preset, user and workspace skills visible to the invoking agent.",
			members, expectedTotal: effective.length, complete: errors.length === 0,
			errors, owner: "skill-providers", workflow: "skill-owner-review",
		});
		result.coverage.skills_total = summaries.length;
		result.coverage.model_invocable_total = effective.length;
		result.coverage.user_only_excluded = summaries.length - effective.length;
		result.coverage.body_projection = "exact-skill-content";
		result.coverage.routing_text_in_body = false;
		result.coverage.loader_wrappers_in_body = false;
		result.coverage.projection_omissions = ["catalog description/whenToUse routing text", "runtime loader tags and resource-base hints"];
		return result;
	} catch (error) {
		return collectClass({ id: "skills-active", kind: "skill", scope: "Active model-invocable skills", members: [], expectedTotal: 1, complete: false, errors: [errorView(error, "skills-registry")], owner: "skill-providers", workflow: "skill-owner-review" });
	}
}

export function discoveryAssessmentSummary(discovery) {
	return {
		mode: discovery.mode,
		requested_classes: ["system", "agents", "skill"],
		agent_scoped: discovery.agent_scoped,
		complete: discovery.complete,
		classes: discovery.classes.map(item => ({
			kind: item.kind, source_id: item.source_id, members_total: item.members_total,
			members_included: item.members_included, omitted_members: item.omitted_members,
			route_limited_members: item.route_limited_members, truncated_members: item.truncated_members,
			source_complete: item.source_complete, routing_complete: item.routing_complete, complete: item.complete,
			...(Number.isSafeInteger(item.configured_files_total) ? { configured_files_total: item.configured_files_total, configured_files_scanned: item.configured_files_scanned, configured_files_omitted: item.configured_files_omitted, managed_policy_targets_omitted: item.managed_policy_targets_omitted } : {}),
			...(Number.isSafeInteger(item.sections_total) ? { sections_total: item.sections_total, sections_scanned: item.sections_scanned,
				original_assembled_bytes: item.original_assembled_bytes, admitted_assembled_bytes: item.admitted_assembled_bytes, assembly_byte_scope: item.assembly_byte_scope } : {}),
			...(Number.isSafeInteger(item.skills_total) ? { skills_total: item.skills_total, model_invocable_total: item.model_invocable_total, user_only_excluded: item.user_only_excluded,
				body_projection: item.body_projection, routing_text_in_body: item.routing_text_in_body, loader_wrappers_in_body: item.loader_wrappers_in_body, projection_omissions: item.projection_omissions } : {}),
			error_codes: item.errors.map(error => error.code),
		})),
	};
}

export function createInstructionSourceDiscovery(ctx, config) {
	return async function discover(exec = {}) {
		if (config.rsiInstructionDiscoveryEnabled !== true) throw new Error("Automatic instruction discovery is disabled; the operator must set rsiInstructionDiscoveryEnabled after reviewing system-prompt, AGENTS and skill disclosure");
		if (!exec.agent) throw new Error("Automatic instruction discovery requires the current invoking agent; explicit source audits remain available for agentless callers");
		const [system, agents, skills] = await Promise.all([
			discoverSystemPrompt(ctx, exec),
			Promise.resolve(discoverInstructionFiles(config)),
			discoverSkills(ctx, exec),
		]);
		const classes = [system.coverage, agents.coverage, skills.coverage];
		return {
			members: [...system.members, ...agents.members, ...skills.members],
			discovery: {
				schema: SOURCE_DISCOVERY_VERSION, mode: "automatic-current-agent-full-coverage",
				captured_at: new Date().toISOString(), provenance: "reassembled-current-agent-scope-at-audit-time",
				agent_scoped: true, complete: classes.every(item => item.complete),
				classes, routes: [system.route, agents.route, skills.route],
				disclosure: "Every included source member is retained in full locally and assessed as a complete member or complete non-overlapping chunks. Separately collected owner routes and provider path metadata remain local; exact instruction bodies may themselves contain paths. Remote assessment occurs only when typesafeEnabled and rsiInstructionDiscoveryEnabled are both true.",
			},
		};
	};
}
