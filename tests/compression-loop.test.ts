import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
    shouldCompress,
    calculateTargetTokens,
    evaluateCompressionPass,
    type CompressionLoopResult,
    type CompressionPassOutcome,
} from "../lib/tools/compress-loop.js"

describe("compression loop utilities", () => {
    describe("calculateTargetTokens", () => {
        it("calculates target as contextTarget * modelContextLimit", () => {
            const target = calculateTargetTokens(200000, 0.4)
            assert.equal(target, 80000)
        })

        it("handles edge case contextTarget of 1.0", () => {
            const target = calculateTargetTokens(200000, 1.0)
            assert.equal(target, 200000)
        })

        it("handles small context limits", () => {
            const target = calculateTargetTokens(1000, 0.4)
            assert.equal(target, 400)
        })
    })

    describe("shouldCompress", () => {
        it("returns true when current exceeds target", () => {
            assert.equal(shouldCompress(100000, 80000), true)
        })

        it("returns false when current is at target", () => {
            assert.equal(shouldCompress(80000, 80000), false)
        })

        it("returns false when current is below target", () => {
            assert.equal(shouldCompress(50000, 80000), false)
        })
    })

    describe("evaluateCompressionPass", () => {
        it("returns continue when tokens still above target and progress made", () => {
            const result = evaluateCompressionPass({
                prevTokens: 100000,
                currentTokens: 90000,
                targetTokens: 80000,
                pass: 1,
                maxPasses: 10,
            })
            assert.equal(result.action, "continue")
        })

        it("returns done when target reached", () => {
            const result = evaluateCompressionPass({
                prevTokens: 90000,
                currentTokens: 80000,
                targetTokens: 80000,
                pass: 2,
                maxPasses: 10,
            })
            assert.equal(result.action, "done")
            assert.equal(result.reason, "target_reached")
        })

        it("returns done when below target", () => {
            const result = evaluateCompressionPass({
                prevTokens: 90000,
                currentTokens: 70000,
                targetTokens: 80000,
                pass: 2,
                maxPasses: 10,
            })
            assert.equal(result.action, "done")
            assert.equal(result.reason, "target_reached")
        })

        it("returns done when no progress made", () => {
            const result = evaluateCompressionPass({
                prevTokens: 100000,
                currentTokens: 100000,
                targetTokens: 80000,
                pass: 2,
                maxPasses: 10,
            })
            assert.equal(result.action, "done")
            assert.equal(result.reason, "no_progress")
        })

        it("returns done when tokens increased (regression)", () => {
            const result = evaluateCompressionPass({
                prevTokens: 90000,
                currentTokens: 95000,
                targetTokens: 80000,
                pass: 2,
                maxPasses: 10,
            })
            assert.equal(result.action, "done")
            assert.equal(result.reason, "no_progress")
        })

        it("returns done when max passes reached", () => {
            const result = evaluateCompressionPass({
                prevTokens: 100000,
                currentTokens: 90000,
                targetTokens: 80000,
                pass: 10,
                maxPasses: 10,
            })
            assert.equal(result.action, "done")
            assert.equal(result.reason, "max_passes")
        })

        it("returns done on first pass if already at target", () => {
            const result = evaluateCompressionPass({
                prevTokens: 80000,
                currentTokens: 75000,
                targetTokens: 80000,
                pass: 1,
                maxPasses: 10,
            })
            assert.equal(result.action, "done")
            assert.equal(result.reason, "target_reached")
        })
    })

    describe("CompressionLoopResult type", () => {
        it("supports expected result structure", () => {
            const result: CompressionLoopResult = {
                totalPasses: 3,
                initialTokens: 100000,
                finalTokens: 75000,
                targetTokens: 80000,
                targetReached: true,
                stopReason: "target_reached",
            }
            assert.equal(result.totalPasses, 3)
            assert.equal(result.targetReached, true)
            assert.equal(result.stopReason, "target_reached")
        })
    })
})
