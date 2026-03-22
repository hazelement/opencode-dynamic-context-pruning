import assert from "node:assert/strict"
import test from "node:test"
import { COMPRESS, COMPRESS_MERGE_MODE } from "../lib/prompts/compress"

// Gap 4: Verify that COMPRESS_MERGE_MODE is suitable for strict mode prompt selection
// The actual wiring is in compress.ts (uses COMPRESS_MERGE_MODE when mergeMode === "strict")

test("COMPRESS_MERGE_MODE is a valid prompt string for tool description", () => {
    assert.ok(typeof COMPRESS_MERGE_MODE === "string")
    assert.ok(COMPRESS_MERGE_MODE.length > 100, "Should be a substantial prompt")
})

test("COMPRESS_MERGE_MODE does not instruct placeholder usage", () => {
    // Strict mode means no (bN) placeholders — the prompt should NOT tell the LLM to use them
    assert.doesNotMatch(
        COMPRESS_MERGE_MODE,
        /Include every required block placeholder exactly once/,
        "Should not contain placeholder inclusion rules",
    )
    // The prompt may mention (bN) to say "do NOT use" them, but should not have
    // the positive instruction to include them
    assert.doesNotMatch(
        COMPRESS_MERGE_MODE,
        /include.*\(bN\).*placeholder/i,
        "Should not instruct including (bN) placeholders",
    )
})

test("COMPRESS prompt does reference placeholder instructions (normal mode)", () => {
    // Normal mode should have placeholder rules
    assert.match(
        COMPRESS,
        /Include every required block placeholder exactly once/,
        "Normal COMPRESS prompt should contain placeholder rules",
    )
})

test("COMPRESS_MERGE_MODE instructs self-contained summaries", () => {
    const lower = COMPRESS_MERGE_MODE.toLowerCase()
    assert.ok(
        lower.includes("self-contained") || lower.includes("completely self-contained"),
        "Should instruct self-contained summaries",
    )
})
