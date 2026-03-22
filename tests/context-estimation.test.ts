import assert from "node:assert/strict"
import test from "node:test"
import { countTokens, estimateContextTokens } from "../lib/strategies/utils"
import type { WithParts } from "../lib/state"

test("estimateContextTokens sums token counts across all messages", () => {
    const messages: WithParts[] = [
        {
            info: { id: "msg-1", role: "user", sessionID: "ses-1" } as any,
            parts: [
                {
                    type: "text",
                    text: "Hello world",
                    id: "p1",
                    messageID: "msg-1",
                    sessionID: "ses-1",
                },
            ],
        },
        {
            info: { id: "msg-2", role: "assistant", sessionID: "ses-1" } as any,
            parts: [
                {
                    type: "text",
                    text: "Hi there, how can I help?",
                    id: "p2",
                    messageID: "msg-2",
                    sessionID: "ses-1",
                },
            ],
        },
    ]

    const result = estimateContextTokens(messages, 0)
    assert.ok(result > 0, "Should return positive token count")
    // Should be roughly the sum of tokens for both messages
    const expected = countTokens("Hello world") + countTokens("Hi there, how can I help?")
    assert.equal(result, expected)
})

test("estimateContextTokens includes systemPromptTokens when provided", () => {
    const messages: WithParts[] = [
        {
            info: { id: "msg-1", role: "user", sessionID: "ses-1" } as any,
            parts: [
                { type: "text", text: "Hello", id: "p1", messageID: "msg-1", sessionID: "ses-1" },
            ],
        },
    ]

    const withoutSystem = estimateContextTokens(messages, 0)
    const withSystem = estimateContextTokens(messages, 500)
    assert.equal(withSystem - withoutSystem, 500)
})

test("estimateContextTokens returns 0 for empty messages", () => {
    const result = estimateContextTokens([], 0)
    assert.equal(result, 0)
})

test("estimateContextTokens counts tool content", () => {
    const messages: WithParts[] = [
        {
            info: { id: "msg-1", role: "assistant", sessionID: "ses-1" } as any,
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    id: "p1",
                    messageID: "msg-1",
                    sessionID: "ses-1",
                    callID: "call-1",
                    state: { status: "completed", output: "file content here with some data" },
                } as any,
            ],
        },
    ]

    const result = estimateContextTokens(messages, 0)
    assert.ok(result > 0, "Should count tool output tokens")
})
