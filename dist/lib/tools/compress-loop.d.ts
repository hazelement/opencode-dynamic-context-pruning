/**
 * Compression loop utilities for iterative context compression.
 *
 * Provides pure functions for calculating compression targets,
 * evaluating whether compression should continue, and tracking
 * loop results. Also provides auto-loop orchestration: state tracking,
 * range selection, loop locking, report formatting, and continuation
 * directive building.
 */
/**
 * Result of a compression loop execution.
 */
export interface CompressionLoopResult {
    /** Number of compression passes executed */
    totalPasses: number;
    /** Token count before any compression */
    initialTokens: number;
    /** Token count after all compression passes */
    finalTokens: number;
    /** Target token count */
    targetTokens: number;
    /** Whether the target was reached */
    targetReached: boolean;
    /** Reason the loop stopped */
    stopReason: "target_reached" | "no_progress" | "max_passes" | "no_compressible_content";
}
/**
 * Outcome of evaluating a single compression pass.
 */
export interface CompressionPassOutcome {
    /** Whether to continue or stop */
    action: "continue" | "done";
    /** Reason for stopping (only set when action is "done") */
    reason?: "target_reached" | "no_progress" | "max_passes";
}
/**
 * Input parameters for evaluating a compression pass.
 */
export interface EvaluatePassInput {
    prevTokens: number;
    currentTokens: number;
    targetTokens: number;
    pass: number;
    maxPasses: number;
}
/**
 * Record of a single auto-loop compression pass.
 */
export interface AutoLoopPassRecord {
    pass: number;
    tokensBefore: number;
    tokensAfter: number;
    rangesCompressed: number;
}
/**
 * State for an active auto-loop compression session.
 */
export interface AutoLoopState {
    sessionId: string;
    passes: AutoLoopPassRecord[];
    initialTokens: number;
    targetTokens: number;
    maxPasses: number;
}
/**
 * A message range eligible for compression.
 */
export interface CompressibleRange {
    messageId: string;
    estimatedTokens: number;
    role: string;
}
/**
 * Input message shape for selectCompressibleRanges.
 */
interface RangeInputMessage {
    role: string;
    id: string;
    tokens: number;
    isCompressed?: boolean;
}
/**
 * Result of buildContinuationDirective.
 */
export interface ContinuationDirective {
    shouldContinue: boolean;
    message: string;
}
/**
 * Calculate the target token count based on model context limit and target percentage.
 */
export declare function calculateTargetTokens(modelContextLimit: number, contextTarget: number): number;
/**
 * Determine whether compression is needed based on current vs target token counts.
 */
export declare function shouldCompress(currentTokens: number, targetTokens: number): boolean;
/**
 * Evaluate whether the compression loop should continue after a pass.
 *
 * Stop conditions:
 * - Target reached (current <= target)
 * - No progress (tokens didn't decrease)
 * - Max passes reached
 */
export declare function evaluateCompressionPass(input: EvaluatePassInput): CompressionPassOutcome;
/**
 * Sanitize maxPasses to a valid integer >= 1. Non-number or invalid values fall back to default (5).
 */
export declare function sanitizeMaxPasses(value: unknown): number;
/**
 * Acquire a loop lock for a session. Returns true if acquired, false if already locked.
 */
export declare function acquireLoopLock(sessionId: string): boolean;
/**
 * Release a loop lock for a session.
 */
export declare function releaseLoopLock(sessionId: string): void;
/**
 * Check if a session's auto-loop is currently locked.
 */
export declare function isLoopLocked(sessionId: string): boolean;
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
export declare function selectCompressibleRanges(messages: RangeInputMessage[], options: {
    protectedTailCount: number;
}): CompressibleRange[];
/**
 * Build a continuation directive for the auto-loop.
 *
 * Decides whether the loop should continue based on:
 * - Target reached → stop
 * - Max passes reached → stop
 * - No meaningful progress (< 2% reduction in last pass) → stop
 * - Otherwise → continue with message
 */
export declare function buildContinuationDirective(state: AutoLoopState, currentTokens: number): ContinuationDirective;
/**
 * Format a human-readable report of the auto-loop execution.
 */
export declare function formatLoopReport(state: AutoLoopState, stopReason: CompressionLoopResult["stopReason"]): string;
export {};
//# sourceMappingURL=compress-loop.d.ts.map