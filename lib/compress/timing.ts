import type { SessionState } from "../state/types"
import { attachCompressionDuration } from "./state"

export interface CompressionStart {
    sessionId: string
    messageId: string
    startedAt: number
}

export interface PendingCompressionDuration {
    callId: string
    messageId: string
    durationMs: number
}

export interface CompressionTimingState {
    startsByCallId: Map<string, CompressionStart>
    pendingBySessionId: Map<string, PendingCompressionDuration[]>
}

export function createCompressionTimingState(): CompressionTimingState {
    return {
        startsByCallId: new Map(),
        pendingBySessionId: new Map(),
    }
}

export function recordCompressionStart(
    state: SessionState,
    callId: string,
    sessionId: string,
    messageId: string,
    startedAt: number,
): boolean {
    if (state.compressionTiming.startsByCallId.has(callId)) {
        return false
    }

    state.compressionTiming.startsByCallId.set(callId, {
        sessionId,
        messageId,
        startedAt,
    })
    return true
}

export function consumeCompressionStart(
    state: SessionState,
    callId: string,
): CompressionStart | undefined {
    const start = state.compressionTiming.startsByCallId.get(callId)
    state.compressionTiming.startsByCallId.delete(callId)
    return start
}

export function clearCompressionStart(state: SessionState, callId: string): void {
    state.compressionTiming.startsByCallId.delete(callId)
}

export function resolveCompressionDuration(
    start: CompressionStart | undefined,
    eventTime: number | undefined,
    partTime: { start?: unknown; end?: unknown } | undefined,
): number | undefined {
    const runningAt =
        typeof partTime?.start === "number" && Number.isFinite(partTime.start)
            ? partTime.start
            : eventTime
    const pendingToRunningMs =
        start && typeof runningAt === "number"
            ? Math.max(0, runningAt - start.startedAt)
            : undefined

    const toolStart = partTime?.start
    const toolEnd = partTime?.end
    const runtimeMs =
        typeof toolStart === "number" &&
        Number.isFinite(toolStart) &&
        typeof toolEnd === "number" &&
        Number.isFinite(toolEnd)
            ? Math.max(0, toolEnd - toolStart)
            : undefined

    return typeof pendingToRunningMs === "number" ? pendingToRunningMs : runtimeMs
}

export function queueCompressionDuration(
    state: SessionState,
    sessionId: string,
    callId: string,
    messageId: string,
    durationMs: number,
): void {
    const queued = state.compressionTiming.pendingBySessionId.get(sessionId) || []
    const filtered = queued.filter((entry) => entry.callId !== callId)
    filtered.push({ callId, messageId, durationMs })
    state.compressionTiming.pendingBySessionId.set(sessionId, filtered)
}

export function applyPendingCompressionDurations(state: SessionState, sessionId: string): number {
    const queued = state.compressionTiming.pendingBySessionId.get(sessionId)
    if (!queued || queued.length === 0) {
        return 0
    }

    let updates = 0
    const remaining = []
    for (const entry of queued) {
        const applied = attachCompressionDuration(
            state.prune.messages,
            entry.callId,
            entry.messageId,
            entry.durationMs,
        )
        if (applied > 0) {
            updates += applied
            continue
        }
        remaining.push(entry)
    }

    if (remaining.length > 0) {
        state.compressionTiming.pendingBySessionId.set(sessionId, remaining)
    } else {
        state.compressionTiming.pendingBySessionId.delete(sessionId)
    }

    return updates
}
