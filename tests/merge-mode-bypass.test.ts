import assert from "node:assert/strict"
import test from "node:test"
import type { CompressionBlock } from "../lib/state"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    validateSummaryPlaceholders,
    wrapCompressedSummary,
    type BoundaryReference,
} from "../lib/tools/utils"

function createBlock(blockId: number, body: string): CompressionBlock {
    return {
        blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        topic: `Block ${blockId}`,
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: wrapCompressedSummary(blockId, body),
    }
}

function createMessageBoundary(messageId: string, rawIndex: number): BoundaryReference {
    return {
        kind: "message",
        messageId,
        rawIndex,
    }
}

function createBlockBoundary(
    blockId: number,
    anchorMessageId: string,
    rawIndex: number,
): BoundaryReference {
    return {
        kind: "compressed-block",
        blockId,
        anchorMessageId,
        rawIndex,
    }
}

// --- Part A: Merge-mode bypasses ---

test("validateSummaryPlaceholders in strict mergeMode skips validation and returns all required as missing", () => {
    const summaryByBlockId = new Map([
        [1, createBlock(1, "First compressed summary")],
        [2, createBlock(2, "Second compressed summary")],
    ])
    const summary = "A fresh self-contained summary with no placeholders"
    const parsed = parseBlockPlaceholders(summary)

    // In strict mode, all required blocks should be returned as missing (skipped)
    const missingBlockIds = validateSummaryPlaceholders(
        parsed,
        [1, 2],
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
        "strict", // mergeMode
    )

    // In strict mode, placeholders should be cleared (none kept)
    assert.equal(parsed.length, 0, "No placeholders should survive in strict mode")
    // All required block IDs returned as missing (since we're not carrying them forward)
    assert.deepEqual(
        missingBlockIds,
        [1, 2],
        "All required blocks should be reported as missing in strict mode",
    )
})

test("validateSummaryPlaceholders in normal mode behaves same as default", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "First compressed summary")]])
    const summary = "Intro (b1) outro"
    const parsed = parseBlockPlaceholders(summary)

    const missingBlockIds = validateSummaryPlaceholders(
        parsed,
        [1],
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
        "normal", // mergeMode — same as default
    )

    assert.deepEqual(
        parsed.map((p) => p.blockId),
        [1],
    )
    assert.equal(missingBlockIds.length, 0)
})

test("injectBlockPlaceholders in strict mergeMode returns summary as-is but consumes required blocks", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Old summary that should NOT appear")]])
    const summary = "A fresh self-contained summary"
    const parsed: any[] = [] // no placeholders in strict mode
    const requiredBlockIds = [1]

    const result = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createBlockBoundary(1, "msg-1", 0), // boundary IS a compressed block
        createMessageBoundary("msg-b", 1),
        "strict", // mergeMode
        requiredBlockIds,
    )

    // Should NOT inject boundary block content in strict mode
    assert.equal(result.expandedSummary, summary, "Summary should remain unchanged in strict mode")
    // But SHOULD consume the required blocks so they get deactivated
    assert.deepEqual(
        result.consumedBlockIds,
        [1],
        "Required blocks should be consumed in strict mode for deactivation",
    )
})

test("injectBlockPlaceholders in strict mergeMode with multiple required blocks consumes all", () => {
    const summaryByBlockId = new Map([
        [1, createBlock(1, "First block")],
        [2, createBlock(2, "Second block")],
        [3, createBlock(3, "Third block")],
    ])
    const summary = "A merged self-contained summary of all three blocks"
    const parsed: any[] = []
    const requiredBlockIds = [1, 2, 3]

    const result = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createBlockBoundary(1, "msg-1", 0),
        createBlockBoundary(3, "msg-3", 5),
        "strict",
        requiredBlockIds,
    )

    assert.equal(result.expandedSummary, summary)
    assert.deepEqual(result.consumedBlockIds, [1, 2, 3])
})

test("injectBlockPlaceholders in strict mergeMode with no requiredBlockIds returns empty consumed", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Block content")]])
    const summary = "A self-contained summary"
    const parsed: any[] = []

    const result = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        "strict",
        // no requiredBlockIds passed
    )

    assert.equal(result.expandedSummary, summary)
    assert.deepEqual(result.consumedBlockIds, [])
})

test("injectBlockPlaceholders in normal mode still expands boundary blocks", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Boundary block content")]])
    const summary = "A summary"
    const parsed: any[] = []

    const result = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createBlockBoundary(1, "msg-1", 0),
        createMessageBoundary("msg-b", 1),
        "normal", // explicit normal
    )

    // Should still inject boundary block content in normal mode
    assert.match(result.expandedSummary, /Boundary block content/)
    assert.deepEqual(result.consumedBlockIds, [1])
})

test("appendMissingBlockSummaries in strict mergeMode returns summary as-is but consumes missing blocks", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Missing block summary")]])
    const summary = "A self-contained summary"

    const result = appendMissingBlockSummaries(
        summary,
        [1], // missing block IDs
        summaryByBlockId,
        [], // consumed block IDs from prior step
        "strict", // mergeMode
    )

    // In strict mode, missing blocks should NOT be appended
    assert.equal(result.expandedSummary, summary, "Summary should remain unchanged in strict mode")
    // But the missing blocks should be consumed for deactivation
    assert.deepEqual(
        result.consumedBlockIds,
        [1],
        "Missing blocks should be consumed in strict mode for deactivation",
    )
})

test("appendMissingBlockSummaries in strict mergeMode merges consumed from prior step", () => {
    const summaryByBlockId = new Map([
        [1, createBlock(1, "Block one")],
        [2, createBlock(2, "Block two")],
    ])
    const summary = "A self-contained summary"

    const result = appendMissingBlockSummaries(
        summary,
        [2], // missing block IDs
        summaryByBlockId,
        [1], // consumed block IDs from prior injectBlockPlaceholders step
        "strict",
    )

    assert.equal(result.expandedSummary, summary)
    // Should merge consumed from prior step with missing blocks
    assert.deepEqual(result.consumedBlockIds.sort(), [1, 2])
})

test("appendMissingBlockSummaries in normal mode still appends missing blocks", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Missing block summary")]])
    const summary = "A summary"

    const result = appendMissingBlockSummaries(
        summary,
        [1],
        summaryByBlockId,
        [],
        "normal", // explicit normal
    )

    assert.match(result.expandedSummary, /Missing block summary/)
    assert.deepEqual(result.consumedBlockIds, [1])
})
