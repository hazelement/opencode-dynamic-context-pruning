/**
 * Compression loop utilities for iterative context compression.
 *
 * Provides pure functions for calculating compression targets,
 * evaluating whether compression should continue, and tracking
 * loop results. Also provides auto-loop orchestration: state tracking,
 * range selection, loop locking, report formatting, and continuation
 * directive building.
 */

// ─── Types ───

/**
 * Result of a compression loop execution.
 */
export interface CompressionLoopResult {
    /** Number of compression passes executed */
    totalPasses: number
    /** Token count before any compression */
    initialTokens: number
    /** Token count after all compression passes */
    finalTokens: number
    /** Target token count */
    targetTokens: number
    /** Whether the target was reached */
    targetReached: boolean
    /** Reason the loop stopped */
    stopReason: "target_reached" | "no_progress" | "max_passes" | "no_compressible_content"
}

/**
 * Outcome of evaluating a single compression pass.
 */
export interface CompressionPassOutcome {
    /** Whether to continue or stop */
    action: "continue" | "done"
    /** Reason for stopping (only set when action is "done") */
    reason?: "target_reached" | "no_progress" | "max_passes"
}

/**
 * Input parameters for evaluating a compression pass.
 */
export interface EvaluatePassInput {
    prevTokens: number
    currentTokens: number
    targetTokens: number
    pass: number
    maxPasses: number
}

/**
 * Record of a single auto-loop compression pass.
 */
export interface AutoLoopPassRecord {
    pass: number
    tokensBefore: number
    tokensAfter: number
    rangesCompressed: number
}

/**
 * State for an active auto-loop compression session.
 */
export interface AutoLoopState {
    sessionId: string
    passes: AutoLoopPassRecord[]
    initialTokens: number
    targetTokens: number
    maxPasses: number
}

/**
 * A message range eligible for compression.
 */
export interface CompressibleRange {
    messageId: string
    estimatedTokens: number
    role: string
}

/**
 * Input message shape for selectCompressibleRanges.
 */
interface RangeInputMessage {
    role: string
    id: string
    tokens: number
    isCompressed?: boolean
}

/**
 * Result of buildContinuationDirective.
 */
export interface ContinuationDirective {
    shouldContinue: boolean
    message: string
}

// ─── Pure functions (existing) ───

/**
 * Calculate the target token count based on model context limit and target percentage.
 */
export function calculateTargetTokens(modelContextLimit: number, contextTarget: number): number {
    return Math.floor(modelContextLimit * contextTarget)
}

/**
 * Determine whether compression is needed based on current vs target token counts.
 */
export function shouldCompress(currentTokens: number, targetTokens: number): boolean {
    return currentTokens > targetTokens
}

/**
 * Evaluate whether the compression loop should continue after a pass.
 *
 * Stop conditions:
 * - Target reached (current <= target)
 * - No progress (tokens didn't decrease)
 * - Max passes reached
 */
export function evaluateCompressionPass(input: EvaluatePassInput): CompressionPassOutcome {
    const { prevTokens, currentTokens, targetTokens, pass, maxPasses } = input

    // Check if target reached
    if (currentTokens <= targetTokens) {
        return { action: "done", reason: "target_reached" }
    }

    // Check if no progress was made (tokens same or increased)
    if (currentTokens >= prevTokens) {
        return { action: "done", reason: "no_progress" }
    }

    // Check if max passes reached
    if (pass >= maxPasses) {
        return { action: "done", reason: "max_passes" }
    }

    return { action: "continue" }
}

/**
 * Sanitize maxPasses to a valid integer >= 1. Non-number or invalid values fall back to default (5).
 */
export function sanitizeMaxPasses(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 5
    }
    const floored = Math.floor(value)
    return floored < 1 ? 1 : floored
}

// ─── Auto-loop orchestration ───

/** Module-level loop lock: prevents concurrent auto-loops per session. */
const loopLocks = new Map<string, boolean>()

/**
 * Acquire a loop lock for a session. Returns true if acquired, false if already locked.
 */
export function acquireLoopLock(sessionId: string): boolean {
    if (loopLocks.get(sessionId)) {
        return false
    }
    loopLocks.set(sessionId, true)
    return true
}

/**
 * Release a loop lock for a session.
 */
export function releaseLoopLock(sessionId: string): void {
    loopLocks.delete(sessionId)
}

/**
 * Check if a session's auto-loop is currently locked.
 */
export function isLoopLocked(sessionId: string): boolean {
    return loopLocks.get(sessionId) === true
}

/**
 * Select message ranges eligible for compression.
 *
 * Excludes:
 * - System messages
 * - Already-compressed messages (isCompressed flag)
 * - Protected tail messages (last N messages)
 *
 * Sorts by estimated token impact descending (highest token messages first).
 */
export function selectCompressibleRanges(
    messages: RangeInputMessage[],
    options: { protectedTailCount: number },
): CompressibleRange[] {
    const { protectedTailCount } = options
    const tailStartIndex = Math.max(0, messages.length - protectedTailCount)

    const ranges: CompressibleRange[] = []

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]

        // Exclude system messages
        if (msg.role === "system") continue

        // Exclude compressed messages
        if (msg.isCompressed) continue

        // Exclude protected tail
        if (i >= tailStartIndex && protectedTailCount > 0) continue

        ranges.push({
            messageId: msg.id,
            estimatedTokens: msg.tokens,
            role: msg.role,
        })
    }

    // Sort by estimated impact descending
    ranges.sort((a, b) => b.estimatedTokens - a.estimatedTokens)

    return ranges
}

/** No-progress threshold: less than 2% reduction means no meaningful progress. */
const NO_PROGRESS_THRESHOLD = 0.02

/**
 * Build a continuation directive for the auto-loop.
 *
 * Decides whether the loop should continue based on:
 * - Target reached → stop
 * - Max passes reached → stop
 * - No meaningful progress (< 2% reduction in last pass) → stop
 * - Otherwise → continue with message
 */
export function buildContinuationDirective(
    state: AutoLoopState,
    currentTokens: number,
): ContinuationDirective {
    // Stop if target reached
    if (currentTokens <= state.targetTokens) {
        return {
            shouldContinue: false,
            message: `Target reached. Current: ${currentTokens}, target: ${state.targetTokens}.`,
        }
    }

    // Stop if max passes reached
    if (state.passes.length >= state.maxPasses) {
        return {
            shouldContinue: false,
            message: `Max passes (${state.maxPasses}) reached. Current: ${currentTokens}, target: ${state.targetTokens}.`,
        }
    }

    // Stop if no meaningful progress in last pass (< 2% reduction)
    if (state.passes.length > 0) {
        const lastPass = state.passes[state.passes.length - 1]
        const reduction = (lastPass.tokensBefore - lastPass.tokensAfter) / lastPass.tokensBefore
        if (reduction < NO_PROGRESS_THRESHOLD) {
            return {
                shouldContinue: false,
                message: `Insufficient progress (${(reduction * 100).toFixed(1)}% reduction). Current: ${currentTokens}, target: ${state.targetTokens}.`,
            }
        }
    }

    // Continue
    return {
        shouldContinue: true,
        message: `Pass ${state.passes.length + 1}: Context at ${currentTokens} tokens, target ${state.targetTokens}. Continue compressing.`,
    }
}

/**
 * Format a human-readable report of the auto-loop execution.
 */
export function formatLoopReport(
    state: AutoLoopState,
    stopReason: CompressionLoopResult["stopReason"],
): string {
    const finalTokens =
        state.passes.length > 0
            ? state.passes[state.passes.length - 1].tokensAfter
            : state.initialTokens

    const lines: string[] = [
        `Auto-compression loop complete.`,
        `Stop reason: ${stopReason}`,
        `Passes: ${state.passes.length}`,
        `Tokens: ${state.initialTokens} → ${finalTokens} (target: ${state.targetTokens})`,
    ]

    if (state.passes.length > 0) {
        const totalReduction = state.initialTokens - finalTokens
        const pct = ((totalReduction / state.initialTokens) * 100).toFixed(1)
        lines.push(`Total reduction: ${totalReduction} tokens (${pct}%)`)
    }

    return lines.join("\n")
}
