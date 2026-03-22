import assert from "node:assert/strict"
import test from "node:test"
import type { CompressionBlock, ProtectedContentEntry } from "../lib/state"

test("CompressionBlock supports optional protectedContent field", () => {
    const block: CompressionBlock = {
        blockId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        topic: "Test block",
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "msg-1",
        compressMessageId: "compress-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-1"],
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "Test summary",
        protectedContent: [
            {
                toolName: "skill",
                callId: "call-1",
                output: "skill content here",
                messageId: "msg-1",
            },
            {
                toolName: "todowrite",
                callId: "call-2",
                output: "todo list content",
                messageId: "msg-1",
            },
        ],
    }

    assert.ok(block.protectedContent, "Should have protectedContent")
    assert.equal(block.protectedContent!.length, 2)
    assert.equal(block.protectedContent![0].toolName, "skill")
    assert.equal(block.protectedContent![1].toolName, "todowrite")
})

test("CompressionBlock protectedContent is optional (backward compatible)", () => {
    const block: CompressionBlock = {
        blockId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 50,
        topic: "Legacy block",
        startId: "m0003",
        endId: "m0004",
        anchorMessageId: "msg-2",
        compressMessageId: "compress-2",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-2"],
        directToolIds: [],
        effectiveMessageIds: ["msg-2"],
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "Legacy summary",
    }

    assert.equal(block.protectedContent, undefined)
})
