import assert from "node:assert/strict"
import test from "node:test"
import { applyProtectedToolRetention } from "../lib/tools/utils"

// applyProtectedToolRetention takes an array of { toolName, output } entries
// and returns at most N per tool name, keeping the LATEST (last in array order)

test("applyProtectedToolRetention keeps latest N outputs per tool name", () => {
    const entries = [
        { toolName: "skill", output: "skill-output-1" },
        { toolName: "skill", output: "skill-output-2" },
        { toolName: "skill", output: "skill-output-3" },
        { toolName: "todowrite", output: "todo-output-1" },
        { toolName: "todowrite", output: "todo-output-2" },
    ]

    const result = applyProtectedToolRetention(entries, 2)

    // Should keep latest 2 per tool name
    assert.equal(result.length, 4)
    // skill: keep last 2 (skill-output-2, skill-output-3)
    const skillOutputs = result.filter((e) => e.toolName === "skill")
    assert.equal(skillOutputs.length, 2)
    assert.equal(skillOutputs[0].output, "skill-output-2")
    assert.equal(skillOutputs[1].output, "skill-output-3")
    // todowrite: keep both (only 2)
    const todoOutputs = result.filter((e) => e.toolName === "todowrite")
    assert.equal(todoOutputs.length, 2)
})

test("applyProtectedToolRetention with retention=0 removes all", () => {
    const entries = [
        { toolName: "skill", output: "skill-output-1" },
        { toolName: "todowrite", output: "todo-output-1" },
    ]

    const result = applyProtectedToolRetention(entries, 0)
    assert.equal(result.length, 0)
})

test("applyProtectedToolRetention with undefined retention keeps all", () => {
    const entries = [
        { toolName: "skill", output: "skill-output-1" },
        { toolName: "skill", output: "skill-output-2" },
        { toolName: "skill", output: "skill-output-3" },
    ]

    const result = applyProtectedToolRetention(entries, undefined)
    assert.equal(result.length, 3)
})

test("applyProtectedToolRetention preserves order within tool groups", () => {
    const entries = [
        { toolName: "skill", output: "A" },
        { toolName: "todowrite", output: "B" },
        { toolName: "skill", output: "C" },
        { toolName: "todowrite", output: "D" },
        { toolName: "skill", output: "E" },
    ]

    const result = applyProtectedToolRetention(entries, 1)

    // Keep latest 1 per tool: skill=E, todowrite=D
    assert.equal(result.length, 2)
    // Order should be preserved relative to original array position
    assert.equal(result[0].toolName, "todowrite")
    assert.equal(result[0].output, "D")
    assert.equal(result[1].toolName, "skill")
    assert.equal(result[1].output, "E")
})

test("applyProtectedToolRetention with retention > count keeps all", () => {
    const entries = [{ toolName: "skill", output: "only-one" }]

    const result = applyProtectedToolRetention(entries, 5)
    assert.equal(result.length, 1)
    assert.equal(result[0].output, "only-one")
})
