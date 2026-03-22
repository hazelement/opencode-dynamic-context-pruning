import assert from "node:assert/strict"
import test from "node:test"
import type { CompressionBlock, ProtectedContentEntry, SessionState } from "../lib/state"
import {
    applyCompressionState,
    wrapCompressedSummary,
    type BoundaryReference,
    type RangeResolution,
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

function createMinimalState(blocks: CompressionBlock[]): SessionState {
    const blocksById = new Map<number, CompressionBlock>()
    const activeBlockIds = new Set<number>()
    const activeByAnchorMessageId = new Map<string, number>()

    for (const block of blocks) {
        blocksById.set(block.blockId, block)
        if (block.active) {
            activeBlockIds.add(block.blockId)
            activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
        }
    }

    return {
        initialized: true,
        version: 1,
        sessionId: "test-session",
        prune: {
            messages: {
                byMessageId: new Map(),
                activeBlockIds,
                activeByAnchorMessageId,
                blocksById,
                nextBlockId: blocks.length + 1,
                blockIdReuse: [],
            },
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        subAgentResultCache: new Map(),
    } as SessionState
}

function createRange(messageIds: string[]): RangeResolution {
    const messageTokenById = new Map<string, number>()
    for (const id of messageIds) {
        messageTokenById.set(id, 100) // dummy token count
    }
    return {
        messageIds,
        toolIds: [],
        requiredBlockIds: [],
        messageTokenById,
        startReference: {
            kind: "message",
            messageId: messageIds[0],
            rawIndex: 0,
        } as BoundaryReference,
        endReference: {
            kind: "message",
            messageId: messageIds[messageIds.length - 1],
            rawIndex: messageIds.length - 1,
        } as BoundaryReference,
    }
}

// --- Tests: applyCompressionState stores protectedContentEntries on block ---

test("applyCompressionState stores protectedContentEntries on new block", () => {
    const state = createMinimalState([])
    const range = createRange(["msg-a", "msg-b"])
    const entries: ProtectedContentEntry[] = [
        { toolName: "skill", callId: "call-1", output: "skill output", messageId: "msg-a" },
        { toolName: "todowrite", callId: "call-2", output: "todo output", messageId: "msg-b" },
    ]

    const result = applyCompressionState(
        state,
        { topic: "Test", startId: "m0001", endId: "m0002", compressMessageId: "compress-test" },
        range,
        "msg-a",
        10,
        wrapCompressedSummary(10, "test summary"),
        [],
        entries,
    )

    const block = state.prune.messages.blocksById.get(10)
    assert.ok(block, "Block should be created")
    assert.ok(block.protectedContent, "Block should have protectedContent")
    assert.equal(block.protectedContent!.length, 2)
    assert.equal(block.protectedContent![0].toolName, "skill")
    assert.equal(block.protectedContent![1].toolName, "todowrite")
})

test("applyCompressionState without protectedContentEntries leaves protectedContent undefined", () => {
    const state = createMinimalState([])
    const range = createRange(["msg-a", "msg-b"])

    applyCompressionState(
        state,
        { topic: "Test", startId: "m0001", endId: "m0002", compressMessageId: "compress-test" },
        range,
        "msg-a",
        10,
        wrapCompressedSummary(10, "test summary"),
        [],
    )

    const block = state.prune.messages.blocksById.get(10)
    assert.ok(block, "Block should be created")
    assert.equal(block.protectedContent, undefined, "No protectedContent when none provided")
})

test("applyCompressionState deactivates consumed blocks and their protectedContent is available for collection", () => {
    // Create a consumed block that has protectedContent
    const consumedBlock = createBlock(1, "old summary")
    consumedBlock.protectedContent = [
        { toolName: "skill", callId: "old-call", output: "old skill output", messageId: "msg-1" },
    ]

    const state = createMinimalState([consumedBlock])
    const range = createRange(["msg-1", "msg-2"])

    // New block consumes block 1 and carries forward its protected content
    const newEntries: ProtectedContentEntry[] = [
        // The old entries from consumed block would be collected by appendProtectedTools
        // and passed here. Simulate that:
        { toolName: "skill", callId: "old-call", output: "old skill output", messageId: "msg-1" },
        { toolName: "skill", callId: "new-call", output: "new skill output", messageId: "msg-2" },
    ]

    applyCompressionState(
        state,
        { topic: "Nested", startId: "m0001", endId: "m0002", compressMessageId: "compress-nested" },
        range,
        "msg-1",
        2,
        wrapCompressedSummary(2, "nested summary"),
        [1], // consuming block 1
        newEntries,
    )

    // Consumed block should be deactivated
    const oldBlock = state.prune.messages.blocksById.get(1)
    assert.ok(oldBlock)
    assert.equal(oldBlock.active, false, "Consumed block should be deactivated")

    // New block should have the carried-forward protected content
    const newBlock = state.prune.messages.blocksById.get(2)
    assert.ok(newBlock)
    assert.ok(newBlock.protectedContent)
    assert.equal(newBlock.protectedContent!.length, 2)
    assert.equal(newBlock.protectedContent![0].output, "old skill output")
    assert.equal(newBlock.protectedContent![1].output, "new skill output")
})

test("applyCompressionState with empty protectedContentEntries array does not set protectedContent", () => {
    const state = createMinimalState([])
    const range = createRange(["msg-a"])

    applyCompressionState(
        state,
        { topic: "Test", startId: "m0001", endId: "m0002", compressMessageId: "compress-test" },
        range,
        "msg-a",
        10,
        wrapCompressedSummary(10, "test summary"),
        [],
        [], // empty array
    )

    const block = state.prune.messages.blocksById.get(10)
    assert.ok(block)
    assert.equal(block.protectedContent, undefined, "Empty array should not set protectedContent")
})
