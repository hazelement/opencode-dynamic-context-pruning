import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { validateConfigTypes, defaultConfig, type PluginConfig } from "../lib/config.js"
import {
    selectCompressibleRanges,
    formatLoopReport,
    buildContinuationDirective,
    acquireLoopLock,
    releaseLoopLock,
    isLoopLocked,
    sanitizeMaxPasses,
    type AutoLoopState,
    type AutoLoopPassRecord,
    type CompressibleRange,
} from "../lib/tools/compress-loop.js"
import { buildAutoLoopSuffix } from "../lib/tools/compress.js"

// ─── Phase 1: Config validation for autoLoop and maxPasses ───

describe("config: autoLoop", () => {
    it("validates autoLoop must be a boolean", () => {
        const config = {
            compress: {
                autoLoop: "yes",
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.autoLoop")
        assert.ok(found, "Should have error for autoLoop being a string")
        assert.equal(found!.expected, "boolean")
    })

    it("validates autoLoop number is invalid", () => {
        const config = {
            compress: {
                autoLoop: 1,
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.autoLoop")
        assert.ok(found, "Should have error for autoLoop being a number")
    })

    it("accepts valid autoLoop true", () => {
        const config = {
            compress: {
                autoLoop: true,
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.autoLoop")
        assert.equal(found, undefined, "Should not have error for valid autoLoop true")
    })

    it("accepts valid autoLoop false", () => {
        const config = {
            compress: {
                autoLoop: false,
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.autoLoop")
        assert.equal(found, undefined, "Should not have error for valid autoLoop false")
    })

    it("accepts undefined autoLoop (uses default)", () => {
        const config = {
            compress: {},
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.autoLoop")
        assert.equal(found, undefined, "Should not have error for undefined autoLoop")
    })
})

describe("config: maxPasses", () => {
    it("validates maxPasses must be a number", () => {
        const config = {
            compress: {
                maxPasses: "five",
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.maxPasses")
        assert.ok(found, "Should have error for maxPasses being a string")
        assert.equal(found!.expected, "integer (>= 1)")
    })

    it("validates maxPasses must be >= 1", () => {
        const config = {
            compress: {
                maxPasses: 0,
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.maxPasses")
        assert.ok(found, "Should have error for maxPasses = 0")
        assert.equal(found!.expected, "integer (>= 1)")
    })

    it("validates negative maxPasses is invalid", () => {
        const config = {
            compress: {
                maxPasses: -1,
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.maxPasses")
        assert.ok(found, "Should have error for negative maxPasses")
    })

    it("accepts valid maxPasses", () => {
        const config = {
            compress: {
                maxPasses: 5,
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.maxPasses")
        assert.equal(found, undefined, "Should not have error for valid maxPasses")
    })

    it("validates non-integer maxPasses is rejected", () => {
        const config = {
            compress: {
                maxPasses: 2.5,
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.maxPasses")
        assert.ok(found, "Should have error for non-integer maxPasses")
        assert.equal(found!.expected, "integer (>= 1)")
    })

    it("accepts maxPasses = 1", () => {
        const config = {
            compress: {
                maxPasses: 1,
            },
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.maxPasses")
        assert.equal(found, undefined, "Should not have error for maxPasses = 1")
    })

    it("accepts undefined maxPasses (uses default)", () => {
        const config = {
            compress: {},
        } as any
        const errors = validateConfigTypes(config)
        const found = errors.find((e) => e.key === "compress.maxPasses")
        assert.equal(found, undefined, "Should not have error for undefined maxPasses")
    })
})

// ─── Phase 2b: sanitizeMaxPasses runtime enforcement ───

describe("sanitizeMaxPasses", () => {
    it("returns valid integer unchanged", () => {
        assert.equal(sanitizeMaxPasses(5), 5)
        assert.equal(sanitizeMaxPasses(1), 1)
        assert.equal(sanitizeMaxPasses(10), 10)
    })

    it("clamps zero to 1", () => {
        assert.equal(sanitizeMaxPasses(0), 1)
    })

    it("clamps negative numbers to 1", () => {
        assert.equal(sanitizeMaxPasses(-1), 1)
        assert.equal(sanitizeMaxPasses(-100), 1)
    })

    it("floors non-integer floats", () => {
        assert.equal(sanitizeMaxPasses(2.5), 2)
        assert.equal(sanitizeMaxPasses(3.9), 3)
    })

    it("floors float and then clamps if result < 1", () => {
        assert.equal(sanitizeMaxPasses(0.5), 1)
    })

    it("returns default 5 for non-number types", () => {
        assert.equal(sanitizeMaxPasses("five" as any), 5)
        assert.equal(sanitizeMaxPasses(undefined as any), 5)
        assert.equal(sanitizeMaxPasses(null as any), 5)
        assert.equal(sanitizeMaxPasses(NaN), 5)
    })
})

// ─── Phase 3: Loop orchestrator functions ───

describe("selectCompressibleRanges", () => {
    it("excludes system messages", () => {
        const messages = [
            { role: "system", id: "sys1", tokens: 500 },
            { role: "user", id: "u1", tokens: 100 },
            { role: "assistant", id: "a1", tokens: 200 },
        ]
        const ranges = selectCompressibleRanges(messages as any, { protectedTailCount: 0 })
        const ids = ranges.map((r) => r.messageId)
        assert.ok(!ids.includes("sys1"), "Should exclude system messages")
    })

    it("excludes compressed messages (those with compressed block markers)", () => {
        const messages = [
            { role: "user", id: "u1", tokens: 100 },
            { role: "assistant", id: "a1", tokens: 200, isCompressed: true },
            { role: "assistant", id: "a2", tokens: 300 },
        ]
        const ranges = selectCompressibleRanges(messages as any, { protectedTailCount: 0 })
        const ids = ranges.map((r) => r.messageId)
        assert.ok(!ids.includes("a1"), "Should exclude compressed messages")
    })

    it("excludes protected tail messages", () => {
        const messages = [
            { role: "user", id: "u1", tokens: 100 },
            { role: "assistant", id: "a1", tokens: 200 },
            { role: "user", id: "u2", tokens: 150 },
            { role: "assistant", id: "a2", tokens: 300 },
        ]
        const ranges = selectCompressibleRanges(messages as any, { protectedTailCount: 2 })
        const ids = ranges.map((r) => r.messageId)
        assert.ok(!ids.includes("u2"), "Should exclude protected tail")
        assert.ok(!ids.includes("a2"), "Should exclude protected tail")
    })

    it("sorts by estimated impact (tokens descending)", () => {
        const messages = [
            { role: "user", id: "u1", tokens: 50 },
            { role: "assistant", id: "a1", tokens: 500 },
            { role: "assistant", id: "a2", tokens: 200 },
        ]
        const ranges = selectCompressibleRanges(messages as any, { protectedTailCount: 0 })
        assert.ok(ranges.length >= 2, "Should have compressible ranges")
        assert.ok(
            ranges[0].estimatedTokens >= ranges[1].estimatedTokens,
            "Should be sorted by impact descending",
        )
    })

    it("returns empty array when all messages are protected", () => {
        const messages = [{ role: "system", id: "sys1", tokens: 500 }]
        const ranges = selectCompressibleRanges(messages as any, { protectedTailCount: 0 })
        assert.equal(ranges.length, 0, "Should return empty for all protected")
    })

    it("returns empty when messages are within tail protection", () => {
        const messages = [
            { role: "user", id: "u1", tokens: 100 },
            { role: "assistant", id: "a1", tokens: 200 },
        ]
        const ranges = selectCompressibleRanges(messages as any, { protectedTailCount: 10 })
        assert.equal(ranges.length, 0, "Should return empty when all in tail")
    })
})

describe("loop lock", () => {
    it("acquires and releases lock", () => {
        const sessionId = "test-lock-" + Date.now()
        assert.equal(isLoopLocked(sessionId), false, "Should start unlocked")
        const acquired = acquireLoopLock(sessionId)
        assert.equal(acquired, true, "Should acquire lock")
        assert.equal(isLoopLocked(sessionId), true, "Should be locked")
        releaseLoopLock(sessionId)
        assert.equal(isLoopLocked(sessionId), false, "Should be unlocked after release")
    })

    it("prevents double acquisition", () => {
        const sessionId = "test-double-lock-" + Date.now()
        acquireLoopLock(sessionId)
        const second = acquireLoopLock(sessionId)
        assert.equal(second, false, "Should not acquire lock twice")
        releaseLoopLock(sessionId)
    })

    it("different sessions have independent locks", () => {
        const s1 = "test-s1-" + Date.now()
        const s2 = "test-s2-" + Date.now()
        acquireLoopLock(s1)
        const acquired = acquireLoopLock(s2)
        assert.equal(acquired, true, "Should acquire lock for different session")
        releaseLoopLock(s1)
        releaseLoopLock(s2)
    })
})

describe("formatLoopReport", () => {
    it("formats report for target reached", () => {
        const state: AutoLoopState = {
            sessionId: "test",
            passes: [
                { pass: 1, tokensBefore: 100000, tokensAfter: 85000, rangesCompressed: 3 },
                { pass: 2, tokensBefore: 85000, tokensAfter: 75000, rangesCompressed: 2 },
            ],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        const report = formatLoopReport(state, "target_reached")
        assert.ok(report.includes("target_reached"), "Should include stop reason")
        assert.ok(report.includes("100000"), "Should include initial tokens")
        assert.ok(report.includes("75000"), "Should include final tokens")
        assert.ok(report.includes("2"), "Should include pass count")
    })

    it("formats report for no_progress", () => {
        const state: AutoLoopState = {
            sessionId: "test",
            passes: [{ pass: 1, tokensBefore: 100000, tokensAfter: 98000, rangesCompressed: 1 }],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        const report = formatLoopReport(state, "no_progress")
        assert.ok(report.includes("no_progress"), "Should include stop reason")
    })

    it("formats report for max_passes", () => {
        const state: AutoLoopState = {
            sessionId: "test",
            passes: [{ pass: 1, tokensBefore: 100000, tokensAfter: 90000, rangesCompressed: 2 }],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 1,
        }
        const report = formatLoopReport(state, "max_passes")
        assert.ok(report.includes("max_passes"), "Should include stop reason")
    })

    it("formats report for no_compressible_content", () => {
        const state: AutoLoopState = {
            sessionId: "test",
            passes: [],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        const report = formatLoopReport(state, "no_compressible_content")
        assert.ok(report.includes("no_compressible_content"), "Should include stop reason")
    })
})

describe("buildContinuationDirective", () => {
    it("builds directive suggesting next pass when loop should continue", () => {
        const state: AutoLoopState = {
            sessionId: "test",
            passes: [{ pass: 1, tokensBefore: 100000, tokensAfter: 90000, rangesCompressed: 3 }],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        const directive = buildContinuationDirective(state, 90000)
        assert.ok(directive.shouldContinue, "Should indicate continuation")
        assert.ok(directive.message.length > 0, "Should have continuation message")
        assert.ok(directive.message.includes("90000"), "Should reference current tokens")
        assert.ok(directive.message.includes("80000"), "Should reference target")
    })

    it("builds stop directive when target reached", () => {
        const state: AutoLoopState = {
            sessionId: "test",
            passes: [{ pass: 1, tokensBefore: 100000, tokensAfter: 75000, rangesCompressed: 3 }],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        const directive = buildContinuationDirective(state, 75000)
        assert.equal(directive.shouldContinue, false, "Should not continue when target reached")
    })

    it("builds stop directive when max passes reached", () => {
        const state: AutoLoopState = {
            sessionId: "test",
            passes: [
                { pass: 1, tokensBefore: 100000, tokensAfter: 95000, rangesCompressed: 2 },
                { pass: 2, tokensBefore: 95000, tokensAfter: 90000, rangesCompressed: 2 },
                { pass: 3, tokensBefore: 90000, tokensAfter: 88000, rangesCompressed: 1 },
            ],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 3,
        }
        const directive = buildContinuationDirective(state, 88000)
        assert.equal(directive.shouldContinue, false, "Should not continue after max passes")
    })

    it("builds stop directive when no progress (< 2% reduction)", () => {
        const state: AutoLoopState = {
            sessionId: "test",
            passes: [{ pass: 1, tokensBefore: 100000, tokensAfter: 99000, rangesCompressed: 1 }],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        const directive = buildContinuationDirective(state, 99000)
        assert.equal(directive.shouldContinue, false, "Should not continue with <2% progress")
    })
})

// ─── Phase 3b: AutoLoopState and AutoLoopPassRecord type tests ───

describe("AutoLoopState type", () => {
    it("supports expected state structure", () => {
        const state: AutoLoopState = {
            sessionId: "sess-123",
            passes: [],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        assert.equal(state.sessionId, "sess-123")
        assert.equal(state.passes.length, 0)
        assert.equal(state.initialTokens, 100000)
        assert.equal(state.targetTokens, 80000)
        assert.equal(state.maxPasses, 5)
    })
})

describe("AutoLoopPassRecord type", () => {
    it("supports expected record structure", () => {
        const record: AutoLoopPassRecord = {
            pass: 1,
            tokensBefore: 100000,
            tokensAfter: 85000,
            rangesCompressed: 3,
        }
        assert.equal(record.pass, 1)
        assert.equal(record.tokensBefore, 100000)
        assert.equal(record.tokensAfter, 85000)
        assert.equal(record.rangesCompressed, 3)
    })
})

// ─── Phase 4: Auto-loop wiring (buildAutoLoopSuffix) ───

describe("buildAutoLoopSuffix", () => {
    // Helper to create minimal context for buildAutoLoopSuffix
    function makeCtx(overrides: {
        autoLoop?: boolean
        maxPasses?: number
        contextTarget?: number
        modelContextLimit?: number
        systemPromptTokens?: number
    }) {
        return {
            config: {
                compress: {
                    ...defaultConfig.compress,
                    autoLoop: overrides.autoLoop ?? true,
                    maxPasses: overrides.maxPasses ?? 5,
                    contextTarget: overrides.contextTarget ?? 0.4,
                },
            },
            state: {
                modelContextLimit: overrides.modelContextLimit ?? 200000,
                systemPromptTokens: overrides.systemPromptTokens ?? 5000,
                sessionId: "test-session",
                autoLoopActive: false,
                autoLoopState: null as AutoLoopState | null,
            },
        }
    }

    describe("when autoLoop=false (backward compatibility)", () => {
        it("returns advisory suffix like original buildLoopEvaluationSuffix", () => {
            const ctx = makeCtx({ autoLoop: false, modelContextLimit: 200000 })
            // currentTokens = 50000 (below target of 80000) → target reached message
            const result = buildAutoLoopSuffix(ctx as any, 50000)
            assert.ok(result.includes("target"), "Should include target info in advisory mode")
            assert.ok(!result.includes("Auto-compression"), "Should not have auto-loop language")
        })

        it("returns advisory recommending more compression when above target", () => {
            const ctx = makeCtx({ autoLoop: false, modelContextLimit: 200000 })
            // currentTokens = 150000, target = 80000 → above target
            const result = buildAutoLoopSuffix(ctx as any, 150000)
            assert.ok(
                result.includes("above target") || result.includes("Consider"),
                "Should recommend more compression",
            )
        })

        it("returns empty string when no contextTarget", () => {
            const ctx = makeCtx({ autoLoop: false, contextTarget: 0, modelContextLimit: 200000 })
            const result = buildAutoLoopSuffix(ctx as any, 100000)
            assert.equal(result, "", "Should return empty when no contextTarget")
        })

        it("returns empty string when no modelContextLimit", () => {
            const ctx = makeCtx({ autoLoop: false, modelContextLimit: 0 })
            const result = buildAutoLoopSuffix(ctx as any, 100000)
            assert.equal(result, "", "Should return empty when no modelContextLimit")
        })
    })

    describe("when autoLoop=true", () => {
        it("returns continuation directive when above target with room for passes", () => {
            const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000, maxPasses: 5 })
            // currentTokens = 120000, target = 80000 → should continue
            const result = buildAutoLoopSuffix(ctx as any, 120000)
            assert.ok(result.includes("120000"), "Should reference current tokens")
            assert.ok(result.includes("80000"), "Should reference target")
            assert.ok(
                result.includes("Continue") || result.includes("continue"),
                "Should indicate continuation",
            )
        })

        it("returns target-reached report when below target", () => {
            const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000 })
            // currentTokens = 50000, target = 80000 → target reached
            const result = buildAutoLoopSuffix(ctx as any, 50000)
            assert.ok(
                result.includes("target_reached") || result.includes("Target reached"),
                "Should indicate target reached",
            )
        })

        it("returns empty string when no contextTarget", () => {
            const ctx = makeCtx({ autoLoop: true, contextTarget: 0, modelContextLimit: 200000 })
            const result = buildAutoLoopSuffix(ctx as any, 100000)
            assert.equal(result, "", "Should return empty when no contextTarget")
        })

        it("returns empty string when no modelContextLimit", () => {
            const ctx = makeCtx({ autoLoop: true, modelContextLimit: 0 })
            const result = buildAutoLoopSuffix(ctx as any, 100000)
            assert.equal(result, "", "Should return empty when no modelContextLimit")
        })

        it("sets autoLoopActive on state when continuing", () => {
            const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000, maxPasses: 5 })
            // currentTokens = 120000, target = 80000 → should continue
            buildAutoLoopSuffix(ctx as any, 120000)
            assert.equal(
                ctx.state.autoLoopActive,
                true,
                "Should set autoLoopActive when continuing",
            )
        })

        it("clears autoLoopActive on state when target reached", () => {
            const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000 })
            ctx.state.autoLoopActive = true
            // currentTokens = 50000, target = 80000 → target reached
            buildAutoLoopSuffix(ctx as any, 50000)
            assert.equal(ctx.state.autoLoopActive, false, "Should clear autoLoopActive when done")
        })

        it("accepts optional loopState for multi-pass tracking", () => {
            const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000, maxPasses: 2 })
            const loopState: AutoLoopState = {
                sessionId: "test",
                passes: [
                    { pass: 1, tokensBefore: 150000, tokensAfter: 120000, rangesCompressed: 3 },
                    { pass: 2, tokensBefore: 120000, tokensAfter: 100000, rangesCompressed: 2 },
                ],
                initialTokens: 150000,
                targetTokens: 80000,
                maxPasses: 2,
            }
            // max passes reached → should stop
            // loopState is now the 4th param (rawMessages is 3rd)
            const result = buildAutoLoopSuffix(ctx as any, 100000, undefined, loopState)
            assert.ok(
                result.includes("max_passes") || result.includes("Max passes"),
                "Should report max passes reached",
            )
        })
    })
})

// ─── Phase 4b: Auto-loop state persistence and lifecycle ───

describe("buildAutoLoopSuffix state persistence", () => {
    function makeCtx(overrides: {
        autoLoop?: boolean
        maxPasses?: number
        contextTarget?: number
        modelContextLimit?: number
    }) {
        return {
            config: {
                compress: {
                    ...defaultConfig.compress,
                    autoLoop: overrides.autoLoop ?? true,
                    maxPasses: overrides.maxPasses ?? 5,
                    contextTarget: overrides.contextTarget ?? 0.4,
                },
            },
            state: {
                modelContextLimit: overrides.modelContextLimit ?? 200000,
                systemPromptTokens: 5000,
                sessionId: "test-session",
                autoLoopActive: false,
                autoLoopState: null as AutoLoopState | null,
            },
        }
    }

    it("persists autoLoopState to ctx.state when continuing", () => {
        const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000, maxPasses: 5 })
        // Pre-seed a state with one pass on ctx.state
        ctx.state.autoLoopState = {
            sessionId: "test-session",
            passes: [{ pass: 1, tokensBefore: 150000, tokensAfter: 120000, rangesCompressed: 2 }],
            initialTokens: 150000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        // 120000 > 80000 → should continue
        buildAutoLoopSuffix(ctx as any, 120000)
        assert.equal(ctx.state.autoLoopActive, true, "Should be active")
        assert.ok(ctx.state.autoLoopState !== null, "Should persist autoLoopState")
        assert.equal(ctx.state.autoLoopState!.passes.length, 1, "Should preserve existing passes")
    })

    it("clears autoLoopState when loop completes (target_reached)", () => {
        const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000 })
        ctx.state.autoLoopActive = true
        ctx.state.autoLoopState = {
            sessionId: "test-session",
            passes: [{ pass: 1, tokensBefore: 150000, tokensAfter: 50000, rangesCompressed: 3 }],
            initialTokens: 150000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        // 50000 < 80000 → target reached, should stop
        const result = buildAutoLoopSuffix(ctx as any, 50000)
        assert.equal(ctx.state.autoLoopActive, false, "Should clear autoLoopActive")
        assert.equal(ctx.state.autoLoopState, null, "Should clear autoLoopState")
        assert.ok(result.includes("target_reached"), "Should report target_reached")
    })

    it("clears autoLoopState when max_passes reached", () => {
        const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000, maxPasses: 2 })
        ctx.state.autoLoopActive = true
        ctx.state.autoLoopState = {
            sessionId: "test-session",
            passes: [
                { pass: 1, tokensBefore: 150000, tokensAfter: 120000, rangesCompressed: 3 },
                { pass: 2, tokensBefore: 120000, tokensAfter: 100000, rangesCompressed: 2 },
            ],
            initialTokens: 150000,
            targetTokens: 80000,
            maxPasses: 2,
        }
        const result = buildAutoLoopSuffix(ctx as any, 100000)
        assert.equal(ctx.state.autoLoopActive, false, "Should clear autoLoopActive")
        assert.equal(ctx.state.autoLoopState, null, "Should clear autoLoopState")
        assert.ok(result.includes("max_passes"), "Should report max_passes")
    })

    it("clears autoLoopState when no_progress detected", () => {
        const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000, maxPasses: 5 })
        ctx.state.autoLoopActive = true
        ctx.state.autoLoopState = {
            sessionId: "test-session",
            passes: [
                // < 2% reduction: 100000 → 99000 = 1% reduction
                { pass: 1, tokensBefore: 100000, tokensAfter: 99000, rangesCompressed: 1 },
            ],
            initialTokens: 100000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        const result = buildAutoLoopSuffix(ctx as any, 99000)
        assert.equal(ctx.state.autoLoopActive, false, "Should clear autoLoopActive")
        assert.equal(ctx.state.autoLoopState, null, "Should clear autoLoopState")
        assert.ok(result.includes("no_progress"), "Should report no_progress")
    })

    it("reads autoLoopState from ctx.state when loopState param not provided", () => {
        const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000, maxPasses: 5 })
        const persistedState: AutoLoopState = {
            sessionId: "test-session",
            passes: [{ pass: 1, tokensBefore: 150000, tokensAfter: 120000, rangesCompressed: 2 }],
            initialTokens: 150000,
            targetTokens: 80000,
            maxPasses: 5,
        }
        ctx.state.autoLoopState = persistedState
        // 120000 > 80000 → should continue, reading state from ctx.state
        const result = buildAutoLoopSuffix(ctx as any, 120000)
        assert.ok(result.includes("120000"), "Should use persisted state")
        assert.ok(result.includes("80000"), "Should reference persisted target")
    })
})

// ─── Phase 4c: no_compressible_content detection ───

describe("buildAutoLoopSuffix no_compressible_content", () => {
    function makeCtx(overrides: {
        autoLoop?: boolean
        maxPasses?: number
        contextTarget?: number
        modelContextLimit?: number
    }) {
        return {
            config: {
                compress: {
                    ...defaultConfig.compress,
                    autoLoop: overrides.autoLoop ?? true,
                    maxPasses: overrides.maxPasses ?? 5,
                    contextTarget: overrides.contextTarget ?? 0.4,
                },
            },
            state: {
                modelContextLimit: overrides.modelContextLimit ?? 200000,
                systemPromptTokens: 5000,
                sessionId: "test-session",
                autoLoopActive: true,
                autoLoopState: null as AutoLoopState | null,
            },
        }
    }

    it("returns no_compressible_content when all messages are system or compressed", () => {
        const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000 })
        // All messages are system or compressed — no compressible ranges
        const rawMessages = [
            {
                info: { role: "system", id: "sys1" },
                parts: [{ text: "system prompt" }],
            },
            {
                info: { role: "assistant", id: "a1" },
                parts: [{ text: "[Compressed conversation section]\nSome summary" }],
            },
        ]
        // 120000 > 80000 target → above target but nothing to compress
        const result = buildAutoLoopSuffix(ctx as any, 120000, rawMessages as any)
        assert.ok(
            result.includes("no_compressible_content"),
            "Should report no_compressible_content",
        )
        assert.equal(ctx.state.autoLoopActive, false, "Should clear autoLoopActive")
        assert.equal(ctx.state.autoLoopState, null, "Should clear autoLoopState")
    })

    it("does not trigger no_compressible_content when compressible messages exist", () => {
        const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000 })
        // Need 6+ messages so first 2 are outside protectedTailCount=4
        const rawMessages = [
            {
                info: { role: "user", id: "u1" },
                parts: [{ text: "hello" }],
            },
            {
                info: { role: "assistant", id: "a1" },
                parts: [{ text: "world ".repeat(100) }],
            },
            {
                info: { role: "user", id: "u2" },
                parts: [{ text: "question" }],
            },
            {
                info: { role: "assistant", id: "a2" },
                parts: [{ text: "answer ".repeat(50) }],
            },
            {
                info: { role: "user", id: "u3" },
                parts: [{ text: "more questions" }],
            },
            {
                info: { role: "assistant", id: "a3" },
                parts: [{ text: "more answers" }],
            },
        ]
        // 120000 > 80000 → above target, u1/a1 are compressible (outside tail)
        const result = buildAutoLoopSuffix(ctx as any, 120000, rawMessages as any)
        assert.ok(
            !result.includes("no_compressible_content"),
            "Should not report no_compressible_content when ranges exist",
        )
    })

    it("skips no_compressible_content check when rawMessages not provided", () => {
        const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000 })
        // No rawMessages → skip check, proceed to normal directive
        const result = buildAutoLoopSuffix(ctx as any, 120000)
        assert.ok(
            !result.includes("no_compressible_content"),
            "Should not check without rawMessages",
        )
    })

    it("skips no_compressible_content check when below target", () => {
        const ctx = makeCtx({ autoLoop: true, modelContextLimit: 200000 })
        const rawMessages = [
            {
                info: { role: "system", id: "sys1" },
                parts: [{ text: "only system" }],
            },
        ]
        // 50000 < 80000 → below target, no_compressible_content check skipped
        const result = buildAutoLoopSuffix(ctx as any, 50000, rawMessages as any)
        assert.ok(
            !result.includes("no_compressible_content"),
            "Should skip check when below target",
        )
        assert.ok(result.includes("target_reached"), "Should report target_reached instead")
    })
})

// ─── Phase 5: Nudge suppression during auto-loop ───

describe("nudge suppression during auto-loop", () => {
    it("injectCompressNudges should be suppressed when autoLoopActive is true", async () => {
        // This is a structural test — we verify the state flag exists and
        // the inject function checks it. Integration-level test.
        const { injectCompressNudges } = await import("../lib/messages/inject/inject.js")

        // Create minimal mock state with autoLoopActive = true
        const state = {
            autoLoopActive: true,
            compressPermission: "allow",
            manualMode: false,
            nudges: {
                compressCallCount: 0,
                lastCompressNudgeAt: 0,
                lastIterationNudgeAt: 0,
            },
            stats: {
                compressToolCalls: 0,
            },
        }

        const messages: any[] = [
            {
                info: { role: "user", id: "u1" },
                inputTokens: 100,
                outputTokens: 0,
            },
        ]

        const config = {
            compress: {
                ...defaultConfig.compress,
                nudgeFrequency: 1,
                nudgeForce: false,
            },
        }

        // Should return without modifying messages
        injectCompressNudges(state as any, messages, config as any, "test-logger" as any)
        // If nudges were injected, the message content would be modified
        // Since autoLoopActive is true, no nudges should be injected
        assert.equal(
            messages[0].info.content,
            undefined,
            "Should not inject nudge content when auto-loop active",
        )
    })
})

// ─── Phase 6: Config defaults and backward compatibility ───

describe("config defaults for auto-loop", () => {
    it("defaultConfig includes autoLoop = true", () => {
        assert.equal(defaultConfig.compress.autoLoop, true, "autoLoop should default to true")
    })

    it("defaultConfig includes maxPasses = 5", () => {
        assert.equal(defaultConfig.compress.maxPasses, 5, "maxPasses should default to 5")
    })

    it("strict mode defaults are preserved", () => {
        assert.equal(defaultConfig.compress.contextTarget, 0.4, "contextTarget should still be 0.4")
        assert.equal(
            defaultConfig.compress.protectedToolRetention,
            2,
            "protectedToolRetention should still be 2",
        )
        assert.equal(defaultConfig.compress.mergeMode, "strict", "mergeMode should still be strict")
    })
})
