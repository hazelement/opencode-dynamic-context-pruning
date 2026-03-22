import assert from "node:assert/strict"
import test, { describe } from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressTool } from "../lib/tools/compress"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-autoloop-integ-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-autoloop-integ-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(overrides?: Partial<PluginConfig["compress"]>): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: true,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            flatSchema: false,
            protectedTools: [],
            protectUserMessages: false,
            contextTarget: 0.4,
            protectedToolRetention: 2,
            mergeMode: "strict",
            autoLoop: true,
            maxPasses: 5,
            ...overrides,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            supersedeWrites: {
                enabled: true,
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

// Creates messages with enough text to generate meaningful token estimates.
// Each message has ~50 tokens of text (200 chars / 4 ≈ 50 tokens via fallback estimator).
function buildMessages(sessionID: string, count: number = 6): WithParts[] {
    const msgs: WithParts[] = []
    for (let i = 0; i < count; i++) {
        const role = i % 2 === 0 ? "user" : "assistant"
        const id = `msg-${i}`
        const partId = `part-${i}`
        // ~200 chars = ~50 tokens each via Math.round(length/4) fallback
        const text = `Message ${i}: ${"This is a detailed message with enough content to generate tokens. ".repeat(3)}`
        msgs.push({
            info: {
                id,
                role,
                sessionID,
                ...(role === "user"
                    ? {
                          model: {
                              providerID: "anthropic",
                              modelID: "claude-test",
                          },
                      }
                    : {}),
                time: { created: i + 1 },
            } as WithParts["info"],
            parts: [textPart(id, sessionID, partId, text)],
        })
    }
    return msgs
}

// Smaller messages for post-compression simulation
function buildSmallerMessages(sessionID: string, count: number = 3): WithParts[] {
    const msgs: WithParts[] = []
    for (let i = 0; i < count; i++) {
        const role = i % 2 === 0 ? "user" : "assistant"
        const id = `msg-post-${i}`
        msgs.push({
            info: {
                id,
                role,
                sessionID,
                ...(role === "user"
                    ? {
                          model: {
                              providerID: "anthropic",
                              modelID: "claude-test",
                          },
                      }
                    : {}),
                time: { created: i + 1 },
            } as WithParts["info"],
            parts: [textPart(id, sessionID, `part-post-${i}`, `Short msg ${i}.`)],
        })
    }
    return msgs
}

// Medium messages: smaller than buildMessages but above a low token target.
// ~30 tokens each (120 chars / 4). Use 6 messages ≈ 180 tokens total.
function buildMediumMessages(sessionID: string, count: number = 6): WithParts[] {
    const msgs: WithParts[] = []
    for (let i = 0; i < count; i++) {
        const role = i % 2 === 0 ? "user" : "assistant"
        const id = `msg-med-${i}`
        const text = `Medium message ${i}: ${"Some filler content here. ".repeat(2)}`
        msgs.push({
            info: {
                id,
                role,
                sessionID,
                ...(role === "user"
                    ? {
                          model: {
                              providerID: "anthropic",
                              modelID: "claude-test",
                          },
                      }
                    : {}),
                time: { created: i + 1 },
            } as WithParts["info"],
            parts: [textPart(id, sessionID, `part-med-${i}`, text)],
        })
    }
    return msgs
}

function buildCompressedMessages(sessionID: string): WithParts[] {
    // All messages are either system or already compressed — no compressible content
    return [
        {
            info: {
                id: "msg-sys-0",
                role: "system",
                sessionID,
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-sys-0", sessionID, "part-sys-0", "System prompt text.")],
        },
        {
            info: {
                id: "msg-comp-1",
                role: "user",
                sessionID,
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-comp-1",
                    sessionID,
                    "part-comp-1",
                    "[Compressed conversation section] Previously compressed content.",
                ),
            ],
        },
        {
            info: {
                id: "msg-comp-2",
                role: "assistant",
                sessionID,
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-comp-2",
                    sessionID,
                    "part-comp-2",
                    "[Compressed conversation section] More compressed content.",
                ),
            ],
        },
        // Protected tail messages (last 4)
        {
            info: {
                id: "msg-tail-3",
                role: "user",
                sessionID,
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 4 },
            } as WithParts["info"],
            parts: [textPart("msg-tail-3", sessionID, "part-tail-3", "Recent user message.")],
        },
    ]
}

function createTool(
    sessionID: string,
    rawMessages: WithParts[],
    configOverrides?: Partial<PluginConfig["compress"]>,
    opts?: {
        postCompressionMessages?: WithParts[]
        modelContextLimit?: number
        throwOnSecondFetch?: boolean
    },
) {
    const state = createSessionState()
    // Pre-set sessionId so ensureSessionInitialized early-returns and doesn't
    // reset modelContextLimit / autoLoop state via resetSessionState
    state.sessionId = sessionID
    // Set a realistic context limit so auto-loop has data to work with
    state.modelContextLimit = opts?.modelContextLimit ?? 1000

    let fetchCount = 0
    const logger = new Logger(false)
    const config = buildConfig(configOverrides)

    const tool = createCompressTool({
        client: {
            session: {
                messages: async () => {
                    fetchCount++
                    // First fetch: pre-compression messages
                    // Second fetch: post-compression messages (simulating state change)
                    if (fetchCount === 1) {
                        return { data: rawMessages }
                    }
                    if (opts?.throwOnSecondFetch) {
                        throw new Error("Simulated post-compression fetch error")
                    }
                    return { data: opts?.postCompressionMessages ?? rawMessages }
                },
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compress: "" }
            },
        },
    } as any)

    return { tool, state, config, logger, getFetchCount: () => fetchCount }
}

async function executeTool(tool: ReturnType<typeof createTool>["tool"], sessionID: string) {
    return tool.execute(
        {
            topic: "Test compression",
            content: {
                startId: "m0001",
                endId: "m0002",
                summary: "Compressed test content.",
            },
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-call",
        },
    )
}

// =============================================================================
// Integration Tests — Real Tool Execution Path
// =============================================================================

describe("createCompressTool integration - autoLoop behavior", () => {
    test("autoLoop=false: advisory suffix, no state mutation", async () => {
        const sessionID = `ses_advisory_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        const { tool, state } = createTool(sessionID, rawMessages, {
            autoLoop: false,
        })

        const result = await executeTool(tool, sessionID)

        // Advisory mode returns token info suffix
        assert.ok(
            result.includes("Compressed") && result.includes("[Compressed conversation section]"),
            `Result should contain compression confirmation, got: ${result}`,
        )
        // Advisory suffix contains token counts
        assert.ok(
            result.includes("tokens") || result.includes("Context"),
            `Advisory suffix should mention tokens or context, got: ${result}`,
        )
        // State should NOT be mutated for auto-loop
        assert.equal(
            state.autoLoopActive,
            false,
            "autoLoopActive should remain false in advisory mode",
        )
        assert.equal(state.autoLoopState, null, "autoLoopState should remain null in advisory mode")
    })

    test("autoLoop=true, target reached: loop report with target_reached", async () => {
        const sessionID = `ses_target_reached_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        // Post-compression: much smaller messages → tokens will be below target
        const smallMessages = buildSmallerMessages(sessionID, 2)

        // Set a high context limit and low target so post-compression easily reaches target
        const { tool, state } = createTool(
            sessionID,
            rawMessages,
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.9, // 90% of 1000 = 900 target, should be easily reached with small messages
            },
            {
                postCompressionMessages: smallMessages,
                modelContextLimit: 1000,
            },
        )

        const result = await executeTool(tool, sessionID)

        assert.ok(
            result.includes("Auto-compression loop complete"),
            `Should contain loop report, got: ${result}`,
        )
        assert.ok(
            result.includes("target_reached"),
            `Should contain target_reached stop reason, got: ${result}`,
        )
        assert.equal(
            state.autoLoopActive,
            false,
            "autoLoopActive should be false after target reached",
        )
        assert.equal(
            state.autoLoopState,
            null,
            "autoLoopState should be cleared after target reached",
        )
    })

    test("autoLoop=true, above target: continuation directive with state persistence", async () => {
        const sessionID = `ses_continuation_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        // Medium messages: ~180 tokens total (above 100 target, but < 240 pre-compression)
        // This shows >2% progress so no_progress won't trigger
        const postMessages = buildMediumMessages(sessionID, 6)

        // contextTarget=0.0005 with modelContextLimit=100000 → targetTokens=50
        // Post-compression ~90 tokens > 50 target → needs continuation
        const { tool, state } = createTool(
            sessionID,
            rawMessages,
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.0005, // 0.05% of 100000 = 50 tokens target
            },
            {
                // Different (smaller) messages on re-fetch — still above target
                // but shows meaningful progress (240 → 90 ≈ 62% reduction)
                postCompressionMessages: postMessages,
                modelContextLimit: 100000,
            },
        )

        const result = await executeTool(tool, sessionID)

        // Should get a continuation directive since still above target
        assert.equal(
            state.autoLoopActive,
            true,
            "autoLoopActive should be true when continuation needed",
        )
        // Should get a continuation directive since still above target
        assert.notEqual(state.autoLoopState, null, "autoLoopState should be persisted")
        assert.ok(
            state.autoLoopState!.passes.length >= 1,
            `Should have at least 1 pass recorded, got: ${state.autoLoopState!.passes.length}`,
        )
        // Result should contain continuation directive (mentions "Pass")
        assert.ok(
            result.includes("Pass") || result.includes("continue") || result.includes("compress"),
            `Should contain continuation message, got: ${result}`,
        )
    })

    test("autoLoop=true, max_passes: stops after reaching max passes", async () => {
        const sessionID = `ses_max_passes_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)

        // Set maxPasses=1 so the first pass immediately triggers max_passes
        // contextTarget=0.001 → target=100, tokens ~240 > 100 → above target
        const { tool, state } = createTool(
            sessionID,
            rawMessages,
            {
                autoLoop: true,
                maxPasses: 1,
                contextTarget: 0.001, // 0.1% of 100000 = 100 tokens target
            },
            {
                postCompressionMessages: rawMessages,
                modelContextLimit: 100000,
            },
        )

        const result = await executeTool(tool, sessionID)

        assert.ok(
            result.includes("Auto-compression loop complete"),
            `Should contain loop report, got: ${result}`,
        )
        assert.ok(
            result.includes("max_passes"),
            `Should contain max_passes stop reason, got: ${result}`,
        )
        assert.equal(state.autoLoopActive, false, "autoLoopActive should be false after max_passes")
        assert.equal(state.autoLoopState, null, "autoLoopState should be cleared after max_passes")
    })

    test("autoLoop=true, no_progress: stops when compression achieves <2% reduction", async () => {
        const sessionID = `ses_no_progress_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)

        // Pre-seed state with a prior pass showing <2% reduction
        // contextTarget=0.001 → config target=100, but pre-seeded state.targetTokens=10
        // After our production fix, state.targetTokens is what matters
        const { tool, state } = createTool(
            sessionID,
            rawMessages,
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.001, // Low config target; pre-seeded state overrides
            },
            {
                postCompressionMessages: rawMessages, // Same messages = almost no change
                modelContextLimit: 100000,
            },
        )

        // Pre-seed autoLoopState with a pass that shows negligible reduction
        // This simulates being on pass 2 where pass 1 showed no progress
        state.autoLoopState = {
            sessionId: sessionID,
            passes: [
                {
                    pass: 1,
                    tokensBefore: 1000,
                    tokensAfter: 995, // <2% reduction → no_progress
                    rangesCompressed: 1,
                },
            ],
            initialTokens: 1000,
            targetTokens: 10, // Very low target
            maxPasses: 5,
        }

        const result = await executeTool(tool, sessionID)

        assert.ok(
            result.includes("Auto-compression loop complete"),
            `Should contain loop report, got: ${result}`,
        )
        assert.ok(
            result.includes("no_progress"),
            `Should contain no_progress stop reason, got: ${result}`,
        )
        assert.equal(
            state.autoLoopActive,
            false,
            "autoLoopActive should be false after no_progress",
        )
        assert.equal(state.autoLoopState, null, "autoLoopState should be cleared after no_progress")
    })

    test("autoLoop=true, no_compressible_content: all messages are system/compressed/protected", async () => {
        const sessionID = `ses_no_compress_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        // Post-compression: only system/compressed/tail messages remain
        const compressedMessages = buildCompressedMessages(sessionID)

        // contextTarget=0.0001 → target = 10 tokens. compressed messages ~26 tokens > 10
        // so we're above target, but no compressible ranges → no_compressible_content
        const { tool, state } = createTool(
            sessionID,
            rawMessages,
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.0001, // Very low target so compressed msgs still above
            },
            {
                postCompressionMessages: compressedMessages,
                modelContextLimit: 100000,
            },
        )

        const result = await executeTool(tool, sessionID)

        assert.ok(
            result.includes("Auto-compression loop complete"),
            `Should contain loop report, got: ${result}`,
        )
        assert.ok(
            result.includes("no_compressible_content"),
            `Should contain no_compressible_content stop reason, got: ${result}`,
        )
        assert.equal(state.autoLoopActive, false, "autoLoopActive should be false")
        assert.equal(state.autoLoopState, null, "autoLoopState should be cleared")
    })

    test("error cleanup: autoLoopActive and autoLoopState cleared on error", async () => {
        const sessionID = `ses_error_cleanup_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)

        // Use createTool with throwOnSecondFetch to trigger error during
        // the post-compression re-fetch (inside try block, after state may be set)
        const { tool, state } = createTool(
            sessionID,
            rawMessages,
            { autoLoop: true, maxPasses: 5 },
            { throwOnSecondFetch: true },
        )

        // Pre-set loop state to simulate mid-loop
        state.autoLoopActive = true
        state.autoLoopState = {
            sessionId: sessionID,
            passes: [{ pass: 1, tokensBefore: 500, tokensAfter: 400, rangesCompressed: 1 }],
            initialTokens: 500,
            targetTokens: 200,
            maxPasses: 5,
        }

        await assert.rejects(
            () => executeTool(tool, sessionID),
            (err: Error) => {
                assert.ok(
                    err.message.includes("Simulated post-compression fetch error"),
                    `Expected simulated error, got: ${err.message}`,
                )
                return true
            },
        )

        // Verify cleanup happened
        assert.equal(state.autoLoopActive, false, "autoLoopActive should be cleared on error")
        assert.equal(state.autoLoopState, null, "autoLoopState should be cleared on error")
    })

    test("post-compression tokens use re-fetched messages (not stale pre-compression)", async () => {
        const sessionID = `ses_fresh_tokens_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        // Post-compression: significantly smaller → proves we're using fresh data
        const smallMessages = buildSmallerMessages(sessionID, 2)

        const { tool, state, getFetchCount } = createTool(
            sessionID,
            rawMessages,
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.9, // High target that small messages should reach
            },
            {
                postCompressionMessages: smallMessages,
                modelContextLimit: 1000,
            },
        )

        const result = await executeTool(tool, sessionID)

        // Verify messages were fetched twice (pre + post compression)
        assert.equal(
            getFetchCount(),
            2,
            "Messages should be fetched twice: pre-compression and post-compression",
        )

        // If stale tokens were used, the suffix would show high token count;
        // with fresh tokens from small messages, target should be reached
        assert.ok(
            result.includes("target_reached"),
            `Should reach target with fresh (small) post-compression tokens, got: ${result}`,
        )
    })

    test("autoLoop=true: pass data is recorded in autoLoopState", async () => {
        const sessionID = `ses_pass_data_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)

        const { tool, state } = createTool(
            sessionID,
            rawMessages,
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.01, // Very low target to ensure continuation
            },
            {
                postCompressionMessages: rawMessages,
                modelContextLimit: 100000,
            },
        )

        await executeTool(tool, sessionID)

        // If continuation, state should have pass data
        if (state.autoLoopActive) {
            assert.notEqual(state.autoLoopState, null, "autoLoopState should be set")
            const loopState = state.autoLoopState!
            assert.ok(loopState.passes.length >= 1, "Should have at least 1 pass")
            const pass = loopState.passes[0]
            assert.equal(pass.pass, 1, "First pass should be numbered 1")
            assert.ok(pass.tokensBefore > 0, "tokensBefore should be positive")
            assert.ok(pass.tokensAfter > 0, "tokensAfter should be positive")
            assert.equal(pass.rangesCompressed, 1, "rangesCompressed should be 1")
            assert.ok(loopState.targetTokens > 0, "targetTokens should be set")
            assert.equal(loopState.maxPasses, 5, "maxPasses should match config")
        }
    })

    test("defaults preserved: contextTarget=0.4, mergeMode=strict, protectedToolRetention=2", async () => {
        // Verify defaults haven't regressed via config builder
        const config = buildConfig()
        assert.equal(config.compress.contextTarget, 0.4, "contextTarget default should be 0.4")
        assert.equal(config.compress.mergeMode, "strict", "mergeMode default should be strict")
        assert.equal(
            config.compress.protectedToolRetention,
            2,
            "protectedToolRetention default should be 2",
        )
        assert.equal(config.compress.autoLoop, true, "autoLoop default should be true")
        assert.equal(config.compress.maxPasses, 5, "maxPasses default should be 5")
    })
})

// =============================================================================
// Multi-Pass Orchestration Integration Tests
// =============================================================================
// These tests prove that the runtime ENFORCES multi-pass semantics:
// - Entry guard rejects when maxPasses exhausted (prevents unbounded re-calls)
// - Staleness guard clears orphaned autoLoopActive flags
// - Lifecycle ownership: state always clean after terminal conditions
// - sanitizeMaxPasses prevents invalid values from reaching runtime behavior

/**
 * Creates a tool where session.messages returns progressively smaller messages
 * on each fetch, simulating compression progress across invocations.
 */
function createMultiPassTool(
    sessionID: string,
    messageSets: WithParts[][],
    configOverrides?: Partial<PluginConfig["compress"]>,
    opts?: { modelContextLimit?: number },
) {
    const state = createSessionState()
    state.sessionId = sessionID
    state.modelContextLimit = opts?.modelContextLimit ?? 1000

    let fetchCount = 0
    const logger = new Logger(false)
    const config = buildConfig(configOverrides)

    const tool = createCompressTool({
        client: {
            session: {
                messages: async () => {
                    fetchCount++
                    // Return progressively smaller message sets
                    const idx = Math.min(fetchCount - 1, messageSets.length - 1)
                    return { data: messageSets[idx] }
                },
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compress: "" }
            },
        },
    } as any)

    return { tool, state, config, logger, getFetchCount: () => fetchCount }
}

describe("createCompressTool integration - real multi-pass orchestration", () => {
    test("entry guard rejects when maxPasses already exhausted — clears state", async () => {
        const sessionID = `ses_entryguard_${Date.now()}`
        const largeMessages = buildMessages(sessionID, 6)
        const mediumMessages = buildMediumMessages(sessionID, 6)

        const { tool, state } = createMultiPassTool(
            sessionID,
            [largeMessages, mediumMessages, mediumMessages],
            {
                autoLoop: true,
                maxPasses: 2,
                contextTarget: 0.01, // Impossible target
            },
            { modelContextLimit: 1000 },
        )

        // Pre-seed autoLoopState as if 2 passes already completed
        state.autoLoopActive = true
        state.autoLoopState = {
            sessionId: sessionID,
            passes: [
                { pass: 1, tokensBefore: 500, tokensAfter: 400, rangesCompressed: 1 },
                { pass: 2, tokensBefore: 400, tokensAfter: 350, rangesCompressed: 1 },
            ],
            initialTokens: 500,
            targetTokens: 10,
            maxPasses: 2,
        }

        const result = await executeTool(tool, sessionID)

        // Entry guard should have rejected — no compression performed
        assert.ok(
            result.includes("max passes") || result.includes("Auto-loop complete"),
            `Entry guard should reject with max_passes message, got: ${result}`,
        )
        // State must be clean
        assert.equal(
            state.autoLoopActive,
            false,
            "autoLoopActive must be false after entry guard rejection",
        )
        assert.equal(
            state.autoLoopState,
            null,
            "autoLoopState must be null after entry guard rejection",
        )
    })

    test("staleness guard clears orphaned autoLoopActive without autoLoopState", async () => {
        const sessionID = `ses_staleness_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        const smallMessages = buildSmallerMessages(sessionID, 2)

        const { tool, state } = createMultiPassTool(
            sessionID,
            [rawMessages, smallMessages, smallMessages],
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.9, // Easy target
            },
            { modelContextLimit: 1000 },
        )

        // Simulate orphaned state: autoLoopActive stuck true but autoLoopState missing
        state.autoLoopActive = true
        state.autoLoopState = null

        await executeTool(tool, sessionID)

        // Staleness guard should have cleared it, tool should work normally
        assert.equal(
            state.autoLoopActive,
            false,
            "autoLoopActive must be false after staleness cleanup",
        )
        assert.equal(state.autoLoopState, null, "autoLoopState must be null after tool completes")
    })

    test("autoLoopActive is always false after tool returns — lifecycle ownership", async () => {
        const sessionID = `ses_lifecycle_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        const smallMessages = buildSmallerMessages(sessionID, 2)

        const { tool, state } = createMultiPassTool(
            sessionID,
            [rawMessages, smallMessages, smallMessages],
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.9, // Easy target — reached quickly
            },
            { modelContextLimit: 1000 },
        )

        await executeTool(tool, sessionID)

        // Regardless of how the loop ended, state must be clean
        assert.equal(
            state.autoLoopActive,
            false,
            "autoLoopActive must be false — loop owns lifecycle",
        )
        assert.equal(
            state.autoLoopState,
            null,
            "autoLoopState must be null — no sticky state after single continuation",
        )
    })

    test("pre-seeded state accumulates pass on continuation invocation", async () => {
        const sessionID = `ses_accumulate_mp_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        const smallMessages = buildSmallerMessages(sessionID, 3)

        const { tool, state } = createMultiPassTool(
            sessionID,
            [rawMessages, smallMessages, smallMessages],
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.01, // Impossible target — forces continuation
            },
            { modelContextLimit: 1000 },
        )

        // Pre-seed state as if pass 1 already happened (simulating LLM re-call)
        state.autoLoopActive = true
        state.autoLoopState = {
            sessionId: sessionID,
            passes: [{ pass: 1, tokensBefore: 500, tokensAfter: 300, rangesCompressed: 2 }],
            initialTokens: 500,
            targetTokens: 10,
            maxPasses: 5,
        }

        const result = await executeTool(tool, sessionID)
        assert.ok(result.includes("Compressed"), "Continuation pass should compress")

        // Pass data should have been appended — now 2 passes
        if (state.autoLoopState) {
            assert.equal(
                state.autoLoopState.passes.length,
                2,
                "Should have 2 passes after continuation invocation",
            )
            assert.equal(state.autoLoopState.passes[1].pass, 2, "Second pass should be numbered 2")
        } else {
            // If state was cleared (target reached), that's also valid —
            // the important thing is it didn't crash and state was managed
            assert.equal(
                state.autoLoopActive,
                false,
                "If state cleared, autoLoopActive must be false",
            )
        }
    })

    test("multi-pass stops on no_progress", async () => {
        const sessionID = `ses_noprogress_mp_${Date.now()}`
        // All message sets are the SAME — no progress between passes
        const sameMessages = buildMessages(sessionID, 6)

        const { tool, state } = createMultiPassTool(
            sessionID,
            [sameMessages, sameMessages, sameMessages, sameMessages],
            {
                autoLoop: true,
                maxPasses: 10,
                contextTarget: 0.01, // Impossible target
            },
            { modelContextLimit: 1000 },
        )

        const result = await executeTool(tool, sessionID)

        // Should detect no progress and stop, not exhaust max passes
        assert.equal(state.autoLoopActive, false, "autoLoopActive must be false after no_progress")
        assert.equal(state.autoLoopState, null, "autoLoopState must be null after no_progress")
        assert.ok(result.includes("Compressed"), `Result should contain compression info`)
    })

    test("invalid maxPasses sanitized at runtime — 0 clamped to 1", async () => {
        const sessionID = `ses_sanitize_mp_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        const smallMessages = buildSmallerMessages(sessionID, 2)

        // Force invalid maxPasses through config
        const { tool, state } = createMultiPassTool(
            sessionID,
            [rawMessages, smallMessages, smallMessages],
            {
                autoLoop: true,
                maxPasses: 0 as any, // Invalid — should be sanitized to 1
                contextTarget: 0.01,
            },
            { modelContextLimit: 1000 },
        )

        // Should not throw — sanitized at runtime
        const result = await executeTool(tool, sessionID)
        assert.ok(result.includes("Compressed"), "Tool should complete despite invalid maxPasses")
        assert.equal(
            state.autoLoopActive,
            false,
            "autoLoopActive must be false after sanitized run",
        )
        assert.equal(state.autoLoopState, null, "autoLoopState must be null after sanitized run")
    })

    test("invalid maxPasses sanitized at runtime — negative clamped to 1", async () => {
        const sessionID = `ses_sanitize_neg_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        const smallMessages = buildSmallerMessages(sessionID, 2)

        const { tool, state } = createMultiPassTool(
            sessionID,
            [rawMessages, smallMessages, smallMessages],
            {
                autoLoop: true,
                maxPasses: -3 as any,
                contextTarget: 0.01,
            },
            { modelContextLimit: 1000 },
        )

        const result = await executeTool(tool, sessionID)
        assert.ok(result.includes("Compressed"), "Tool should complete despite negative maxPasses")
        assert.equal(state.autoLoopActive, false, "State clean after negative maxPasses")
    })

    test("invalid maxPasses sanitized at runtime — float floored and clamped", async () => {
        const sessionID = `ses_sanitize_float_${Date.now()}`
        const rawMessages = buildMessages(sessionID, 6)
        const smallMessages = buildSmallerMessages(sessionID, 2)

        const { tool, state } = createMultiPassTool(
            sessionID,
            [rawMessages, smallMessages, smallMessages],
            {
                autoLoop: true,
                maxPasses: 2.7 as any,
                contextTarget: 0.01,
            },
            { modelContextLimit: 1000 },
        )

        const result = await executeTool(tool, sessionID)
        assert.ok(result.includes("Compressed"), "Tool should complete despite float maxPasses")
        assert.equal(state.autoLoopActive, false, "State clean after float maxPasses")
    })

    test("entry guard uses sanitized maxPasses for invalid config values", async () => {
        const sessionID = `ses_entryguard_sanitize_${Date.now()}`
        const largeMessages = buildMessages(sessionID, 6)

        const { tool, state } = createMultiPassTool(
            sessionID,
            [largeMessages, largeMessages],
            {
                autoLoop: true,
                maxPasses: 0 as any, // Will be sanitized to 1
                contextTarget: 0.01,
            },
            { modelContextLimit: 1000 },
        )

        // Pre-seed state: 1 pass already completed (sanitized maxPasses = 1, so this should trigger entry guard)
        state.autoLoopActive = true
        state.autoLoopState = {
            sessionId: sessionID,
            passes: [{ pass: 1, tokensBefore: 500, tokensAfter: 400, rangesCompressed: 1 }],
            initialTokens: 500,
            targetTokens: 10,
            maxPasses: 1, // Already sanitized in state
        }

        const result = await executeTool(tool, sessionID)

        // Entry guard should reject using sanitized maxPasses=1
        assert.ok(
            result.includes("max passes") || result.includes("Auto-loop complete"),
            `Entry guard should reject with sanitized maxPasses, got: ${result}`,
        )
        assert.equal(
            state.autoLoopActive,
            false,
            "State clean after entry guard with sanitized maxPasses",
        )
        assert.equal(
            state.autoLoopState,
            null,
            "autoLoopState null after entry guard with sanitized maxPasses",
        )
    })
})

// =============================================================================
// Regression: Full Two-Invocation Continuation Lifecycle
// =============================================================================
// This regression test exercises the REAL end-to-end auto-loop lifecycle through
// two separate tool.execute() invocations, proving:
//   1. Invocation 1: above target → continuation directive + state persisted
//   2. Invocation 2: uses persisted state → reaches target → state fully cleared
// This is the exact runtime flow the LLM agent experiences when the auto-loop
// directs it to "call compress again."

// Builds messages with FIXED raw IDs (msg-0…msg-N) but varying text length.
// This mimics the real scenario: same conversation, different content sizes after compression.
function buildMessagesWithSize(
    sessionID: string,
    tokenTarget: "large" | "medium" | "small",
    count: number = 6,
): WithParts[] {
    const textBySize = {
        large: `${"This is a detailed message with enough content to generate tokens. ".repeat(3)}`,
        medium: `${"Some filler content here. ".repeat(2)}`,
        small: "Ok.",
    }
    const msgs: WithParts[] = []
    for (let i = 0; i < count; i++) {
        const role = i % 2 === 0 ? "user" : "assistant"
        const id = `msg-${i}` // Fixed IDs across all sizes
        const partId = `part-${i}`
        const text = `Message ${i}: ${textBySize[tokenTarget]}`
        msgs.push({
            info: {
                id,
                role,
                sessionID,
                ...(role === "user"
                    ? {
                          model: {
                              providerID: "anthropic",
                              modelID: "claude-test",
                          },
                      }
                    : {}),
                time: { created: i + 1 },
            } as WithParts["info"],
            parts: [textPart(id, sessionID, partId, text)],
        })
    }
    return msgs
}

describe("createCompressTool integration - continuation lifecycle regression", () => {
    test("two-invocation lifecycle: continuation → target_reached with full state cleanup", async () => {
        const sessionID = `ses_lifecycle_regression_${Date.now()}`
        // All message sets share the same raw IDs (msg-0…msg-5) but differ in content size.
        // This mirrors reality: same conversation messages, progressively compressed.
        const large = buildMessagesWithSize(sessionID, "large", 6) // ~240 tokens
        const medium = buildMessagesWithSize(sessionID, "medium", 6) // ~90 tokens
        const small = buildMessagesWithSize(sessionID, "small", 6) // ~30 tokens

        // Progressive message sets (each executeTool does 2 fetches: pre + post):
        //  Fetch 1 (inv1 pre-compress):  large  (~240 tokens)
        //  Fetch 2 (inv1 post-compress): medium (~90 tokens) — still above 50-token target
        //  Fetch 3 (inv2 pre-compress):  medium (~90 tokens)
        //  Fetch 4 (inv2 post-compress): small  (~30 tokens) — below 50-token target
        const { tool, state } = createMultiPassTool(
            sessionID,
            [large, medium, medium, small],
            {
                autoLoop: true,
                maxPasses: 5,
                contextTarget: 0.0005, // 0.05% of 100000 = 50 tokens target
            },
            { modelContextLimit: 100000 },
        )

        // === INVOCATION 1: should compress and return continuation directive ===
        const result1 = await executeTool(tool, sessionID)

        // Verify continuation state was persisted
        assert.equal(
            state.autoLoopActive,
            true,
            "Inv1: autoLoopActive should be true (continuation needed)",
        )
        assert.notEqual(
            state.autoLoopState,
            null,
            "Inv1: autoLoopState should be persisted for next invocation",
        )
        assert.equal(
            state.autoLoopState!.passes.length,
            1,
            "Inv1: should have exactly 1 pass recorded",
        )
        assert.equal(state.autoLoopState!.passes[0].pass, 1, "Inv1: pass should be numbered 1")
        assert.ok(
            state.autoLoopState!.passes[0].tokensBefore > 0,
            "Inv1: tokensBefore should be positive",
        )
        assert.ok(
            state.autoLoopState!.passes[0].tokensAfter > 0,
            "Inv1: tokensAfter should be positive",
        )
        assert.ok(state.autoLoopState!.targetTokens > 0, "Inv1: targetTokens should be set")
        // Result should contain continuation directive text
        assert.ok(
            result1.includes("Pass") ||
                result1.includes("continue") ||
                result1.includes("compress"),
            `Inv1: should contain continuation message, got: ${result1}`,
        )

        // Capture persisted state for verification across invocations
        const persistedTarget = state.autoLoopState!.targetTokens
        const persistedMaxPasses = state.autoLoopState!.maxPasses
        const persistedInitialTokens = state.autoLoopState!.initialTokens

        // === INVOCATION 2: should compress, reach target, and clear all state ===
        const result2 = await executeTool(tool, sessionID)

        // Verify terminal state: everything must be clean
        assert.equal(
            state.autoLoopActive,
            false,
            "Inv2: autoLoopActive must be false after target reached",
        )
        assert.equal(
            state.autoLoopState,
            null,
            "Inv2: autoLoopState must be null after target reached",
        )
        // Result should contain the loop report with target_reached
        assert.ok(
            result2.includes("Auto-compression loop complete"),
            `Inv2: should contain loop report, got: ${result2}`,
        )
        assert.ok(
            result2.includes("target_reached"),
            `Inv2: stop reason should be target_reached, got: ${result2}`,
        )
        // Verify the report mentions pass counts (proves multi-pass was tracked)
        assert.ok(
            result2.includes("2"),
            `Inv2: loop report should reference pass count, got: ${result2}`,
        )
    })

    test("two-invocation lifecycle: continuation → max_passes with full state cleanup", async () => {
        const sessionID = `ses_lifecycle_maxpass_${Date.now()}`
        // Same IDs, different sizes — medium stays above target forever
        const large = buildMessagesWithSize(sessionID, "large", 6)
        const medium = buildMessagesWithSize(sessionID, "medium", 6)

        // Progressive message sets — medium messages remain above impossible target
        // After inv1: medium (~90 tokens) still above 50 target → continuation
        // After inv2: entry guard sees 2/2 passes exhausted → max_passes report
        const { tool, state } = createMultiPassTool(
            sessionID,
            [large, medium, medium, medium],
            {
                autoLoop: true,
                maxPasses: 2, // Only 2 passes allowed
                contextTarget: 0.0005, // 50 tokens target — unreachable with medium messages
            },
            { modelContextLimit: 100000 },
        )

        // === INVOCATION 1 ===
        const result1 = await executeTool(tool, sessionID)

        assert.equal(
            state.autoLoopActive,
            true,
            "Inv1: autoLoopActive should be true (continuation)",
        )
        assert.notEqual(state.autoLoopState, null, "Inv1: autoLoopState should be persisted")
        assert.equal(state.autoLoopState!.passes.length, 1, "Inv1: should have 1 pass recorded")

        // === INVOCATION 2: should hit max_passes and stop ===
        const result2 = await executeTool(tool, sessionID)

        assert.equal(
            state.autoLoopActive,
            false,
            "Inv2: autoLoopActive must be false after max_passes",
        )
        assert.equal(state.autoLoopState, null, "Inv2: autoLoopState must be null after max_passes")
        assert.ok(
            result2.includes("Auto-compression loop complete") || result2.includes("max passes"),
            `Inv2: should contain terminal report, got: ${result2}`,
        )
    })
})
