import { createHash } from "node:crypto";

export const RECORD_BUDGET = 128 * 1024;
export const bytes = value => Buffer.byteLength(JSON.stringify(value));
export function reviewFits(state, questions) {
	// Reserve typed answers, interpretation and metadata before paid inference or
	// persistence, including disabled/unavailable attempts. Do not clip evidence.
	return bytes({ state, questions }) + bytes(questions) * 2 + 16384 <= RECORD_BUDGET;
}
export function retainedInput(state, questions, availableBytes = RECORD_BUDGET) {
	const full = { state, questions };
	if (reviewFits(state, questions) && bytes(full) <= Math.max(0, availableBytes)) return full;
	const input = JSON.stringify(full);
	return { input_retained: false, input_bytes: Buffer.byteLength(input), input_sha256: createHash("sha256").update(input).digest("hex"), limitation: "Input exceeds durable assessment budget; narrow selected context. No evidence was truncated into a passing judgment." };
}
