/**
 * Compression loop utilities for iterative context compression.
 *
 * Provides pure functions for calculating compression targets,
 * evaluating whether compression should continue, and tracking
 * loop results. Also provides auto-loop orchestration: state tracking,
 * range selection, loop locking, report formatting, and continuation
 * directive building.
 */
// ─── Pure functions (existing) ───
/**
 * Calculate the target token count based on model context limit and target percentage.
 */
export function calculateTargetTokens(modelContextLimit, contextTarget) {
    return Math.floor(modelContextLimit * contextTarget);
}
/**
 * Determine whether compression is needed based on current vs target token counts.
 */
export function shouldCompress(currentTokens, targetTokens) {
    return currentTokens > targetTokens;
}
/**
 * Evaluate whether the compression loop should continue after a pass.
 *
 * Stop conditions:
 * - Target reached (current <= target)
 * - No progress (tokens didn't decrease)
 * - Max passes reached
 */
export function evaluateCompressionPass(input) {
    const { prevTokens, currentTokens, targetTokens, pass, maxPasses } = input;
    // Check if target reached
    if (currentTokens <= targetTokens) {
        return { action: "done", reason: "target_reached" };
    }
    // Check if no progress was made (tokens same or increased)
    if (currentTokens >= prevTokens) {
        return { action: "done", reason: "no_progress" };
    }
    // Check if max passes reached
    if (pass >= maxPasses) {
        return { action: "done", reason: "max_passes" };
    }
    return { action: "continue" };
}
/**
 * Sanitize maxPasses to a valid integer >= 1. Non-number or invalid values fall back to default (5).
 */
export function sanitizeMaxPasses(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 5;
    }
    const floored = Math.floor(value);
    return floored < 1 ? 1 : floored;
}
// ─── Auto-loop orchestration ───
/** Module-level loop lock: prevents concurrent auto-loops per session. */
const loopLocks = new Map();
/**
 * Acquire a loop lock for a session. Returns true if acquired, false if already locked.
 */
export function acquireLoopLock(sessionId) {
    if (loopLocks.get(sessionId)) {
        return false;
    }
    loopLocks.set(sessionId, true);
    return true;
}
/**
 * Release a loop lock for a session.
 */
export function releaseLoopLock(sessionId) {
    loopLocks.delete(sessionId);
}
/**
 * Check if a session's auto-loop is currently locked.
 */
export function isLoopLocked(sessionId) {
    return loopLocks.get(sessionId) === true;
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
export function selectCompressibleRanges(messages, options) {
    const { protectedTailCount } = options;
    const tailStartIndex = Math.max(0, messages.length - protectedTailCount);
    const ranges = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        // Exclude system messages
        if (msg.role === "system")
            continue;
        // Exclude compressed messages
        if (msg.isCompressed)
            continue;
        // Exclude protected tail
        if (i >= tailStartIndex && protectedTailCount > 0)
            continue;
        ranges.push({
            messageId: msg.id,
            estimatedTokens: msg.tokens,
            role: msg.role,
        });
    }
    // Sort by estimated impact descending
    ranges.sort((a, b) => b.estimatedTokens - a.estimatedTokens);
    return ranges;
}
/** No-progress threshold: less than 2% reduction means no meaningful progress. */
const NO_PROGRESS_THRESHOLD = 0.02;
/**
 * Build a continuation directive for the auto-loop.
 *
 * Decides whether the loop should continue based on:
 * - Target reached → stop
 * - Max passes reached → stop
 * - No meaningful progress (< 2% reduction in last pass) → stop
 * - Otherwise → continue with message
 */
export function buildContinuationDirective(state, currentTokens) {
    // Stop if target reached
    if (currentTokens <= state.targetTokens) {
        return {
            shouldContinue: false,
            message: `Target reached. Current: ${currentTokens}, target: ${state.targetTokens}.`,
        };
    }
    // Stop if max passes reached
    if (state.passes.length >= state.maxPasses) {
        return {
            shouldContinue: false,
            message: `Max passes (${state.maxPasses}) reached. Current: ${currentTokens}, target: ${state.targetTokens}.`,
        };
    }
    // Stop if no meaningful progress in last pass (< 2% reduction)
    if (state.passes.length > 0) {
        const lastPass = state.passes[state.passes.length - 1];
        const reduction = (lastPass.tokensBefore - lastPass.tokensAfter) / lastPass.tokensBefore;
        if (reduction < NO_PROGRESS_THRESHOLD) {
            return {
                shouldContinue: false,
                message: `Insufficient progress (${(reduction * 100).toFixed(1)}% reduction). Current: ${currentTokens}, target: ${state.targetTokens}.`,
            };
        }
    }
    // Continue
    return {
        shouldContinue: true,
        message: `Pass ${state.passes.length + 1}: Context at ${currentTokens} tokens, target ${state.targetTokens}. Continue compressing.`,
    };
}
/**
 * Format a human-readable report of the auto-loop execution.
 */
export function formatLoopReport(state, stopReason) {
    const finalTokens = state.passes.length > 0
        ? state.passes[state.passes.length - 1].tokensAfter
        : state.initialTokens;
    const lines = [
        `Auto-compression loop complete.`,
        `Stop reason: ${stopReason}`,
        `Passes: ${state.passes.length}`,
        `Tokens: ${state.initialTokens} → ${finalTokens} (target: ${state.targetTokens})`,
    ];
    if (state.passes.length > 0) {
        const totalReduction = state.initialTokens - finalTokens;
        const pct = ((totalReduction / state.initialTokens) * 100).toFixed(1);
        lines.push(`Total reduction: ${totalReduction} tokens (${pct}%)`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=compress-loop.js.map