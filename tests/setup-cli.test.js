import test from "node:test";
import assert from "node:assert/strict";
import { instructionDiscoverySetting } from "../bin/setup.js";

test("installer discovery consent can be granted, preserved, and revoked", () => {
	assert.equal(instructionDiscoverySetting({}, {}), false);
	assert.equal(instructionDiscoverySetting({ "enable-instruction-discovery": true }, {}), true);
	assert.equal(instructionDiscoverySetting({}, { rsiInstructionDiscoveryEnabled: true }), true);
	assert.equal(instructionDiscoverySetting({ "disable-instruction-discovery": true }, { rsiInstructionDiscoveryEnabled: true }), false);
	assert.throws(
		() => instructionDiscoverySetting({ "enable-instruction-discovery": true, "disable-instruction-discovery": true }, {}),
		/Choose only one/,
	);
});
