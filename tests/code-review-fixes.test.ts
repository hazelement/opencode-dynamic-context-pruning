import assert from "node:assert/strict"
import test from "node:test"
import { isContextOverLimits, buildCompressedBlockGuidance } from "../lib/messages/inject/utils"
import { loadPruneMessagesState } from "../lib/state/utils"
import type { PluginConfig } from "../lib/config"
import type { SessionState, WithParts, ProtectedContentEntry, CompressionBlock } from "../lib/state"

// =============================================================================
// Fix 1: contextTarget wired into runtime nudge/decision path
// =============================================================================

function createPluginConfig(overrides?: Partial<PluginConfig["compress"]>): PluginConfig {
    return {
        compress: {
            enabled: true,
            maxContextLimit: undefined,
            minContextLimit: undefined,
            nudgeFrequency: 1,
            iterationNudgeThreshold: 1,
            nudgeForce: "normal",
            contextTarget: undefined,
            mergeMode: "normal",
            protectedToolRetention: 2,
            ...overrides,
        },
    } as PluginConfig
}

function createMessages(count: number, textPerMessage: string = "x".repeat(500)): WithParts[] {
    return Array.from({ length: count }, (_, i) => ({
        info: {
            id: `msg-${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            sessionID: "ses-1",
        } as any,
        parts: [
            {
                type: "text" as const,
                text: textPerMessage,
                id: `p-${i}`,
                messageID: `msg-${i}`,
                sessionID: "ses-1",
            },
        ],
    }))
}

function createState(overrides?: Partial<SessionState>): SessionState {
    return {
        sessionId: "test-session",
        isSubAgent: false,
        manualMode: false,
        compressPermission: "allow",
        pendingManualTrigger: null,
        prune: {
            tools: new Map(),
            messages: {
                byMessageId: new Map(),
                blocksById: new Map(),
                activeBlockIds: new Set(),
                activeByAnchorMessageId: new Map(),
                nextBlockId: 1,
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        toolParameters: new Map(),
        subAgentResultCache: new Map(),
        toolIdList: [],
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        lastCompaction: 0,
        currentTurn: 0,
        variant: undefined,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
        ...overrides,
    } as SessionState
}

test("isContextOverLimits returns overContextTarget=false when contextTarget is not configured", () => {
    const config = createPluginConfig({ contextTarget: undefined })
    const state = createState({ modelContextLimit: 100_000 })
    const messages = createMessages(10)

    const result = isContextOverLimits(config, state, undefined, undefined, messages)
    assert.equal(result.overContextTarget, false)
})

test("isContextOverLimits returns overContextTarget=false when modelContextLimit is not set", () => {
    const config = createPluginConfig({ contextTarget: 0.4 })
    const state = createState({ modelContextLimit: undefined })
    const messages = createMessages(10)

    const result = isContextOverLimits(config, state, undefined, undefined, messages)
    assert.equal(result.overContextTarget, false)
})

test("isContextOverLimits returns overContextTarget=true when estimated tokens exceed target", () => {
    // With contextTarget=0.4 and modelContextLimit=1000, target is 400 tokens.
    // Need messages whose total tokens (via real tokenizer) exceed 400.
    // A repeated natural-language sentence tokenizes to ~13 tokens each repetition.
    // 40 reps ≈ 520 tokens > 400 target.
    const longText =
        "This is a test message with multiple words to estimate tokens accurately. ".repeat(40)
    const config = createPluginConfig({ contextTarget: 0.4 })
    const state = createState({ modelContextLimit: 1000, systemPromptTokens: 0 })
    const messages = createMessages(4, longText)

    const result = isContextOverLimits(config, state, undefined, undefined, messages)
    assert.equal(result.overContextTarget, true)
})

test("isContextOverLimits returns overContextTarget=false when estimated tokens are below target", () => {
    // With contextTarget=0.4 and modelContextLimit=100_000, target is 40_000 tokens.
    // 2 small messages should be well under 40k.
    const config = createPluginConfig({ contextTarget: 0.4 })
    const state = createState({ modelContextLimit: 100_000, systemPromptTokens: 0 })
    const messages = createMessages(2, "hello")

    const result = isContextOverLimits(config, state, undefined, undefined, messages)
    assert.equal(result.overContextTarget, false)
})

test("isContextOverLimits includes systemPromptTokens in context target estimation", () => {
    // With contextTarget=0.4 and modelContextLimit=1000, target is 400 tokens.
    // 1 small message (~2 tokens) but 500 systemPromptTokens => 502 > 400
    const config = createPluginConfig({ contextTarget: 0.4 })
    const state = createState({ modelContextLimit: 1000, systemPromptTokens: 500 })
    const messages = createMessages(1, "hi")

    const result = isContextOverLimits(config, state, undefined, undefined, messages)
    assert.equal(result.overContextTarget, true)
})

test("isContextOverLimits ignores contextTarget when contextTarget is 0", () => {
    const config = createPluginConfig({ contextTarget: 0 })
    const state = createState({ modelContextLimit: 100, systemPromptTokens: 0 })
    const messages = createMessages(10)

    const result = isContextOverLimits(config, state, undefined, undefined, messages)
    assert.equal(result.overContextTarget, false)
})

test("isContextOverLimits ignores contextTarget when contextTarget >= 1", () => {
    const config = createPluginConfig({ contextTarget: 1 as any })
    const state = createState({ modelContextLimit: 100, systemPromptTokens: 0 })
    const messages = createMessages(10)

    const result = isContextOverLimits(config, state, undefined, undefined, messages)
    assert.equal(result.overContextTarget, false)
})

// =============================================================================
// Fix 2: protectedContent persistence in loadPruneMessagesState
// =============================================================================

test("loadPruneMessagesState restores protectedContent on blocks", () => {
    const protectedContent: ProtectedContentEntry[] = [
        { toolName: "skill", callId: "call-1", output: "skill output", messageId: "msg-a" },
        { toolName: "todowrite", callId: "call-2", output: "todo output", messageId: "msg-b" },
    ]

    const persisted = {
        nextBlockId: 2,
        byMessageId: {},
        blocksById: {
            "1": {
                blockId: 1,
                active: true,
                deactivatedByUser: false,
                compressedTokens: 100,
                topic: "Test block",
                startId: "m0001",
                endId: "m0002",
                anchorMessageId: "msg-a",
                compressMessageId: "compress-1",
                includedBlockIds: [],
                consumedBlockIds: [],
                parentBlockIds: [],
                directMessageIds: ["msg-a"],
                directToolIds: [],
                effectiveMessageIds: ["msg-a"],
                effectiveToolIds: [],
                createdAt: 1,
                summary: "test summary",
                protectedContent,
            },
        },
        activeBlockIds: [1],
        activeByAnchorMessageId: { "msg-a": 1 },
    }

    const state = loadPruneMessagesState(persisted)
    const block = state.blocksById.get(1)
    assert.ok(block, "Block should be loaded")
    assert.ok(block.protectedContent, "protectedContent should be restored")
    assert.equal(block.protectedContent!.length, 2)
    assert.equal(block.protectedContent![0].toolName, "skill")
    assert.equal(block.protectedContent![0].callId, "call-1")
    assert.equal(block.protectedContent![0].output, "skill output")
    assert.equal(block.protectedContent![0].messageId, "msg-a")
    assert.equal(block.protectedContent![1].toolName, "todowrite")
})

test("loadPruneMessagesState returns undefined protectedContent when not present in persisted data", () => {
    const persisted = {
        nextBlockId: 2,
        byMessageId: {},
        blocksById: {
            "1": {
                blockId: 1,
                active: true,
                deactivatedByUser: false,
                compressedTokens: 50,
                topic: "No protected",
                startId: "m0001",
                endId: "m0002",
                anchorMessageId: "msg-a",
                compressMessageId: "compress-1",
                includedBlockIds: [],
                consumedBlockIds: [],
                parentBlockIds: [],
                directMessageIds: [],
                directToolIds: [],
                effectiveMessageIds: [],
                effectiveToolIds: [],
                createdAt: 1,
                summary: "summary",
                // No protectedContent field
            },
        },
        activeBlockIds: [1],
        activeByAnchorMessageId: {},
    }

    const state = loadPruneMessagesState(persisted)
    const block = state.blocksById.get(1)
    assert.ok(block)
    assert.equal(block.protectedContent, undefined, "Should be undefined when not persisted")
})

test("loadPruneMessagesState filters invalid protectedContent entries", () => {
    const persisted = {
        nextBlockId: 2,
        byMessageId: {},
        blocksById: {
            "1": {
                blockId: 1,
                active: true,
                deactivatedByUser: false,
                compressedTokens: 50,
                topic: "Mixed valid/invalid",
                startId: "m0001",
                endId: "m0002",
                anchorMessageId: "msg-a",
                compressMessageId: "compress-1",
                includedBlockIds: [],
                consumedBlockIds: [],
                parentBlockIds: [],
                directMessageIds: [],
                directToolIds: [],
                effectiveMessageIds: [],
                effectiveToolIds: [],
                createdAt: 1,
                summary: "summary",
                protectedContent: [
                    // Valid entry
                    { toolName: "skill", callId: "c1", output: "out", messageId: "m1" },
                    // Invalid: missing messageId
                    { toolName: "skill", callId: "c2", output: "out" },
                    // Invalid: not an object
                    "not-an-object",
                    // Invalid: toolName is number
                    { toolName: 42, callId: "c3", output: "out", messageId: "m3" },
                    // Valid entry
                    { toolName: "todowrite", callId: "c4", output: "out2", messageId: "m4" },
                ],
            },
        },
        activeBlockIds: [1],
        activeByAnchorMessageId: {},
    }

    const state = loadPruneMessagesState(persisted)
    const block = state.blocksById.get(1)
    assert.ok(block)
    assert.ok(block.protectedContent, "Should have filtered protectedContent")
    assert.equal(block.protectedContent!.length, 2, "Only 2 valid entries should survive")
    assert.equal(block.protectedContent![0].callId, "c1")
    assert.equal(block.protectedContent![1].callId, "c4")
})

test("loadPruneMessagesState returns undefined protectedContent for empty array", () => {
    const persisted = {
        nextBlockId: 2,
        byMessageId: {},
        blocksById: {
            "1": {
                blockId: 1,
                active: true,
                deactivatedByUser: false,
                compressedTokens: 50,
                topic: "Empty array",
                startId: "m0001",
                endId: "m0002",
                anchorMessageId: "msg-a",
                compressMessageId: "compress-1",
                includedBlockIds: [],
                consumedBlockIds: [],
                parentBlockIds: [],
                directMessageIds: [],
                directToolIds: [],
                effectiveMessageIds: [],
                effectiveToolIds: [],
                createdAt: 1,
                summary: "summary",
                protectedContent: [],
            },
        },
        activeBlockIds: [1],
        activeByAnchorMessageId: {},
    }

    const state = loadPruneMessagesState(persisted)
    const block = state.blocksById.get(1)
    assert.ok(block)
    assert.equal(block.protectedContent, undefined, "Empty array should yield undefined")
})

// =============================================================================
// Fix 3: Strict-mode guidance conflicts in buildCompressedBlockGuidance
// =============================================================================

function createStateWithBlocks(blockIds: number[]): SessionState {
    const state = createState()
    for (const id of blockIds) {
        state.prune.messages.activeBlockIds.add(id)
    }
    return state
}

test("buildCompressedBlockGuidance in normal mode includes placeholder instructions", () => {
    const state = createStateWithBlocks([1, 2])
    const guidance = buildCompressedBlockGuidance(state, "normal")

    assert.match(guidance, /Active compressed blocks.*2.*b1, b2/)
    assert.match(guidance, /\(bN\)/, "Normal mode should reference (bN) placeholders")
    assert.doesNotMatch(guidance, /Do NOT use.*\(bN\)/, "Normal mode should not say 'Do NOT use'")
})

test("buildCompressedBlockGuidance in strict mode omits placeholder usage and includes anti-placeholder guidance", () => {
    const state = createStateWithBlocks([1, 3])
    const guidance = buildCompressedBlockGuidance(state, "strict")

    assert.match(guidance, /Active compressed blocks.*2.*b1, b3/)
    assert.match(
        guidance,
        /Do NOT use.*\(bN\)/i,
        "Strict mode should instruct not to use (bN) placeholders",
    )
    assert.match(guidance, /merged inline/i, "Strict mode should mention blocks are merged inline")
    // Should NOT have the positive placeholder inclusion instruction
    assert.doesNotMatch(
        guidance,
        /include each required placeholder exactly once/i,
        "Strict mode should not instruct including placeholders",
    )
})

test("buildCompressedBlockGuidance with no mergeMode defaults to normal (placeholder) guidance", () => {
    const state = createStateWithBlocks([5])
    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /\(bN\)/, "Default (no mergeMode) should reference placeholders")
    assert.doesNotMatch(guidance, /Do NOT use/, "Default should not say 'Do NOT use'")
})

test("buildCompressedBlockGuidance with no active blocks still includes mode-specific text", () => {
    const stateStrict = createStateWithBlocks([])
    const guidanceStrict = buildCompressedBlockGuidance(stateStrict, "strict")
    assert.match(guidanceStrict, /Active compressed blocks.*0.*none/)
    assert.match(guidanceStrict, /Do NOT use.*\(bN\)/i)

    const stateNormal = createStateWithBlocks([])
    const guidanceNormal = buildCompressedBlockGuidance(stateNormal, "normal")
    assert.match(guidanceNormal, /Active compressed blocks.*0.*none/)
    assert.match(guidanceNormal, /\(bN\)/)
})
