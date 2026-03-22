import assert from "node:assert/strict"
import test from "node:test"
import { validateConfigTypes, type PluginConfig } from "../lib/config"

// Test: contextTarget field validation
test("config validates contextTarget must be a number", () => {
    const config = {
        compress: {
            contextTarget: "not-a-number",
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.contextTarget")
    assert.ok(found, "Should have error for contextTarget being a string")
    assert.equal(found!.expected, "number (0 to 1)")
})

test("config validates contextTarget must be between 0 and 1", () => {
    const config = {
        compress: {
            contextTarget: 1.5,
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.contextTarget")
    assert.ok(found, "Should have error for contextTarget > 1")
    assert.match(found!.expected, /0 to 1/)
})

test("config validates contextTarget 0 is invalid (must be > 0)", () => {
    const config = {
        compress: {
            contextTarget: 0,
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.contextTarget")
    assert.ok(found, "Should have error for contextTarget = 0")
})

test("config accepts valid contextTarget", () => {
    const config = {
        compress: {
            contextTarget: 0.4,
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.contextTarget")
    assert.equal(found, undefined, "Should not have error for valid contextTarget")
})

// Test: protectedToolRetention field validation
test("config validates protectedToolRetention must be a number", () => {
    const config = {
        compress: {
            protectedToolRetention: "two",
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.protectedToolRetention")
    assert.ok(found, "Should have error for protectedToolRetention being a string")
    assert.equal(found!.expected, "number (>= 0)")
})

test("config validates protectedToolRetention must be >= 0", () => {
    const config = {
        compress: {
            protectedToolRetention: -1,
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.protectedToolRetention")
    assert.ok(found, "Should have error for negative protectedToolRetention")
})

test("config accepts valid protectedToolRetention", () => {
    const config = {
        compress: {
            protectedToolRetention: 2,
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.protectedToolRetention")
    assert.equal(found, undefined, "Should not have error for valid protectedToolRetention")
})

// Test: mergeMode field validation
test("config validates mergeMode must be 'strict' or 'normal'", () => {
    const config = {
        compress: {
            mergeMode: "invalid",
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.mergeMode")
    assert.ok(found, "Should have error for invalid mergeMode")
    assert.equal(found!.expected, '"strict" | "normal"')
})

test("config accepts valid mergeMode 'strict'", () => {
    const config = {
        compress: {
            mergeMode: "strict",
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.mergeMode")
    assert.equal(found, undefined, "Should not have error for valid mergeMode")
})

test("config accepts valid mergeMode 'normal'", () => {
    const config = {
        compress: {
            mergeMode: "normal",
        },
    } as any
    const errors = validateConfigTypes(config)
    const found = errors.find((e) => e.key === "compress.mergeMode")
    assert.equal(found, undefined, "Should not have error for valid mergeMode")
})
