import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
    appendProtectedTools,
    applyProtectedToolRetention,
    type ProtectedToolEntry,
} from "../lib/tools/utils.js"
import type { SessionState } from "../lib/state/types.js"
import type { RangeResolution, SearchContext } from "../lib/tools/utils.js"

/**
 * Integration tests verifying that the merge-mode flag, protected tool retention,
 * and compression loop utilities are properly threaded through the compress tool flow.
 */

// Helper to create a minimal session state
function buildSessionState(): SessionState {
    return {
        modelContextLimit: 200000,
        systemPromptTokens: 5000,
        prune: {
            messages: {
                byMessageId: new Map(),
                byToolId: new Map(),
            },
            blocks: new Map(),
            nextBlockId: 1,
        },
        subAgentResultCache: new Map(),
        sessionId: "test-session",
        manualMode: false,
        permissionCheckComplete: false,
    } as unknown as SessionState
}

// Helper to build a search context with specific messages
function buildSearchContext(
    messages: Array<{
        id: string
        role: string
        parts: any[]
    }>,
): SearchContext {
    const rawMessagesById = new Map<string, any>()
    for (const msg of messages) {
        rawMessagesById.set(msg.id, {
            info: { id: msg.id, role: msg.role },
            parts: msg.parts,
        })
    }

    return {
        rawMessagesById,
        summaryByBlockId: new Map(),
        blocksByAnchorMessageId: new Map(),
    } as unknown as SearchContext
}

describe("integration: appendProtectedTools with retention", () => {
    it("collects protected tool outputs and applies retention when protectedToolRetention is passed", async () => {
        const state = buildSessionState()

        // Create messages with multiple protected tool outputs
        const messages = [
            {
                id: "msg1",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "skill",
                        callID: "call1",
                        state: { status: "completed", output: "skill output 1" },
                    },
                ],
            },
            {
                id: "msg2",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "skill",
                        callID: "call2",
                        state: { status: "completed", output: "skill output 2" },
                    },
                ],
            },
            {
                id: "msg3",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "skill",
                        callID: "call3",
                        state: { status: "completed", output: "skill output 3" },
                    },
                ],
            },
            {
                id: "msg4",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "todowrite",
                        callID: "call4",
                        state: { status: "completed", output: "todo output 1" },
                    },
                ],
            },
        ]

        const searchContext = buildSearchContext(messages)
        const range: RangeResolution = {
            messageIds: ["msg1", "msg2", "msg3", "msg4"],
            toolIds: [],
            requiredBlockIds: [],
            startReference: { type: "message", messageId: "msg1" } as any,
            endReference: { type: "message", messageId: "msg4" } as any,
        }

        // Call with retention = 2 — should keep only latest 2 skill outputs + 1 todowrite
        const result = await appendProtectedTools(
            {} as any, // client — not used since no subagent lookup
            state,
            false,
            "base summary",
            range,
            searchContext,
            ["skill", "todowrite"],
            [],
            2, // protectedToolRetention
        )

        // appendProtectedTools now returns { summary, protectedContentEntries }
        const summary = result.summary

        // Should contain the protected tools heading
        assert.ok(summary.includes("The following protected tools were used"))

        // Should contain skill output 2, skill output 3 (latest 2), and todo output 1
        assert.ok(summary.includes("skill output 2"), "should have skill output 2 (latest 2)")
        assert.ok(summary.includes("skill output 3"), "should have skill output 3 (latest 2)")
        assert.ok(summary.includes("todo output 1"), "should have todo output 1 (only 1 exists)")

        // Should NOT contain skill output 1 (oldest, trimmed by retention)
        assert.ok(!summary.includes("skill output 1"), "should NOT have skill output 1 (trimmed)")
    })

    it("keeps all outputs when protectedToolRetention is undefined", async () => {
        const state = buildSessionState()

        const messages = [
            {
                id: "msg1",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "skill",
                        callID: "call1",
                        state: { status: "completed", output: "skill output 1" },
                    },
                ],
            },
            {
                id: "msg2",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "skill",
                        callID: "call2",
                        state: { status: "completed", output: "skill output 2" },
                    },
                ],
            },
        ]

        const searchContext = buildSearchContext(messages)
        const range: RangeResolution = {
            messageIds: ["msg1", "msg2"],
            toolIds: [],
            requiredBlockIds: [],
            startReference: { type: "message", messageId: "msg1" } as any,
            endReference: { type: "message", messageId: "msg2" } as any,
        }

        // Call without retention — should keep all
        const result = await appendProtectedTools(
            {} as any,
            state,
            false,
            "base summary",
            range,
            searchContext,
            ["skill"],
            [],
            undefined, // no retention
        )

        // appendProtectedTools now returns { summary, protectedContentEntries }
        const summary = result.summary
        assert.ok(summary.includes("skill output 1"), "should have skill output 1")
        assert.ok(summary.includes("skill output 2"), "should have skill output 2")
    })
})
