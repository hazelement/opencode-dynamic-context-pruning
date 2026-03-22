import assert from "node:assert/strict"
import test from "node:test"
import { COMPRESS, COMPRESS_MERGE_MODE } from "../lib/prompts/compress"

test("COMPRESS_MERGE_MODE exists and differs from COMPRESS", () => {
    assert.ok(COMPRESS_MERGE_MODE, "COMPRESS_MERGE_MODE should be exported")
    assert.ok(typeof COMPRESS_MERGE_MODE === "string", "Should be a string")
    assert.notEqual(COMPRESS_MERGE_MODE, COMPRESS, "Should differ from regular COMPRESS prompt")
})

test("COMPRESS_MERGE_MODE instructs LLM to NOT use block placeholders", () => {
    assert.ok(
        COMPRESS_MERGE_MODE.toLowerCase().includes("do not") ||
            COMPRESS_MERGE_MODE.toLowerCase().includes("must not") ||
            COMPRESS_MERGE_MODE.toLowerCase().includes("never"),
        "Should instruct against using placeholders",
    )
    // Should not contain the placeholder rules section
    assert.doesNotMatch(
        COMPRESS_MERGE_MODE,
        /Include every required block placeholder exactly once/,
        "Should not contain normal placeholder rules",
    )
})

test("COMPRESS_MERGE_MODE preserves core compress philosophy", () => {
    assert.ok(
        COMPRESS_MERGE_MODE.includes("EXHAUSTIVE") || COMPRESS_MERGE_MODE.includes("exhaustive"),
        "Should preserve exhaustive summary requirement",
    )
    assert.ok(
        COMPRESS_MERGE_MODE.includes("USER INTENT FIDELITY") ||
            COMPRESS_MERGE_MODE.includes("user intent"),
        "Should preserve user intent fidelity",
    )
})
