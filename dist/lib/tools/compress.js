import { tool } from "@opencode-ai/plugin";
import { ensureSessionInitialized } from "../state";
import { appendMissingBlockSummaries, appendProtectedUserMessages, appendProtectedTools, wrapCompressedSummary, allocateBlockId, applyCompressionState, buildSearchContext, fetchSessionMessages, COMPRESSED_BLOCK_HEADER, injectBlockPlaceholders, parseBlockPlaceholders, resolveAnchorMessageId, resolveBoundaryIds, resolveRange, normalizeCompressArgs, validateCompressArgs, validateSummaryPlaceholders, } from "./utils";
import { isIgnoredUserMessage } from "../messages/utils";
import { assignMessageRefs } from "../message-ids";
import { getCurrentParams, getCurrentTokenUsage, countTokens, estimateContextTokens, } from "../strategies/utils";
import { deduplicate, purgeErrors } from "../strategies";
import { saveSessionState } from "../state/persistence";
import { sendCompressNotification } from "../ui/notification";
import { NESTED_FORMAT_OVERLAY, FLAT_FORMAT_OVERLAY } from "../prompts/internal-overlays";
import { COMPRESS_MERGE_MODE } from "../prompts/compress";
import { calculateTargetTokens, evaluateCompressionPass, buildContinuationDirective, formatLoopReport, selectCompressibleRanges, sanitizeMaxPasses, } from "./compress-loop";
// This schema looks better in the TUI (non primitive args aren't displayed), but LLMs are more likely to fail
// the tool call
function buildNestedSchema() {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .object({
            startId: tool.schema
                .string()
                .describe("Message or block ID marking the beginning of range (e.g. m0001, b2)"),
            endId: tool.schema
                .string()
                .describe("Message or block ID marking the end of range (e.g. m0012, b5)"),
            summary: tool.schema
                .string()
                .describe("Complete technical summary replacing all content in range"),
        })
            .describe("Compression details: ID boundaries and replacement summary"),
    };
}
// Simpler schema for models that are not as good at tool calling reliably
function buildFlatSchema() {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        startId: tool.schema
            .string()
            .describe("Message or block ID marking the beginning of range (e.g. m0001, b2)"),
        endId: tool.schema
            .string()
            .describe("Message or block ID marking the end of range (e.g. m0012, b5)"),
        summary: tool.schema
            .string()
            .describe("Complete technical summary replacing all content in range"),
    };
}
/**
 * Build a suffix for the compress return message that communicates
 * loop evaluation status: whether the context target has been reached
 * or more compression is recommended.
 */
function buildLoopEvaluationSuffix(ctx, rawMessages) {
    const { contextTarget } = ctx.config.compress;
    const modelContextLimit = ctx.state.modelContextLimit;
    const systemPromptTokens = ctx.state.systemPromptTokens;
    // If we don't have enough info for evaluation, skip the suffix
    if (!contextTarget || !modelContextLimit) {
        return "";
    }
    const targetTokens = calculateTargetTokens(modelContextLimit, contextTarget);
    const currentTokens = estimateContextTokens(rawMessages, systemPromptTokens ?? 0);
    const outcome = evaluateCompressionPass({
        prevTokens: currentTokens, // no prev tracking, use current
        currentTokens,
        targetTokens,
        pass: 1,
        maxPasses: 10, // not a real limit — the LLM controls invocations
    });
    if (outcome.action === "done" && outcome.reason === "target_reached") {
        return ` Context target reached (${currentTokens}/${targetTokens} tokens, ${Math.round((currentTokens / modelContextLimit) * 100)}% of limit).`;
    }
    // Context is still above target — recommend more compression
    const pct = Math.round((currentTokens / modelContextLimit) * 100);
    return ` Context still above target: ${currentTokens}/${targetTokens} tokens (${pct}% of ${modelContextLimit} limit, target ${Math.round(contextTarget * 100)}%). Consider compressing more stale ranges.`;
}
/**
 * Build a suffix for the compress return message that handles both
 * auto-loop and advisory modes.
 *
 * When autoLoop=true: uses continuation directive logic, manages autoLoopActive state,
 * persists loop state across invocations via ctx.state.autoLoopState, records pass,
 * and checks for no_compressible_content via selectCompressibleRanges.
 *
 * When autoLoop=false: delegates to original advisory behavior.
 *
 * @param ctx - Tool context with config and state
 * @param currentTokens - Current token count AFTER compression (must be post-compression)
 * @param rawMessages - Current raw messages for compressible range detection
 * @param loopState - Optional loop state override (for testing); normally read from ctx.state
 * @returns Suffix string to append to compress return message
 */
export function buildAutoLoopSuffix(ctx, currentTokens, rawMessages, loopState) {
    const { contextTarget, autoLoop, maxPasses } = ctx.config.compress;
    const modelContextLimit = ctx.state.modelContextLimit;
    // If we don't have enough info for evaluation, skip the suffix
    if (!contextTarget || !modelContextLimit) {
        return "";
    }
    const targetTokens = calculateTargetTokens(modelContextLimit, contextTarget);
    // Advisory mode (autoLoop=false): preserve original behavior
    if (!autoLoop) {
        if (currentTokens <= targetTokens) {
            return ` Context target reached (${currentTokens}/${targetTokens} tokens, ${Math.round((currentTokens / modelContextLimit) * 100)}% of limit).`;
        }
        const pct = Math.round((currentTokens / modelContextLimit) * 100);
        return ` Context still above target: ${currentTokens}/${targetTokens} tokens (${pct}% of ${modelContextLimit} limit, target ${Math.round(contextTarget * 100)}%). Consider compressing more stale ranges.`;
    }
    // Auto-loop mode: use persisted or provided state
    const state = loopState ??
        ctx.state.autoLoopState ?? {
        sessionId: ctx.state.sessionId ?? "unknown",
        passes: [],
        initialTokens: currentTokens,
        targetTokens,
        maxPasses: sanitizeMaxPasses(maxPasses),
    };
    // Check for no_compressible_content if rawMessages available
    // Use state.targetTokens for consistency with buildContinuationDirective
    if (rawMessages && currentTokens > state.targetTokens) {
        const compressibleMessages = rawMessages.map((m) => ({
            role: m.info.role,
            id: m.info.id,
            tokens: countTokens(m.parts?.map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("") ??
                ""),
            isCompressed: m.parts?.some((p) => typeof p === "object" &&
                p.text?.includes("[Compressed conversation section]")) ?? false,
        }));
        const ranges = selectCompressibleRanges(compressibleMessages, { protectedTailCount: 4 });
        if (ranges.length === 0) {
            ctx.state.autoLoopActive = false;
            ctx.state.autoLoopState = null;
            return ` ${formatLoopReport(state, "no_compressible_content")}`;
        }
    }
    const directive = buildContinuationDirective(state, currentTokens);
    if (directive.shouldContinue) {
        // Persist state for next invocation
        ctx.state.autoLoopActive = true;
        ctx.state.autoLoopState = state;
        return ` ${directive.message}`;
    }
    // Loop is done — clear state and return report
    ctx.state.autoLoopActive = false;
    ctx.state.autoLoopState = null;
    // Use state.targetTokens for consistency with buildContinuationDirective
    const stopReason = currentTokens <= state.targetTokens
        ? "target_reached"
        : state.passes.length >= state.maxPasses
            ? "max_passes"
            : "no_progress";
    return ` ${formatLoopReport(state, stopReason)}`;
}
export function createCompressTool(ctx) {
    ctx.prompts.reload();
    const runtimePrompts = ctx.prompts.getRuntimePrompts();
    const useFlatSchema = ctx.config.compress.flatSchema;
    const mergeMode = ctx.config.compress.mergeMode;
    const basePrompt = mergeMode === "strict" ? COMPRESS_MERGE_MODE : runtimePrompts.compress;
    return tool({
        description: basePrompt + (useFlatSchema ? FLAT_FORMAT_OVERLAY : NESTED_FORMAT_OVERLAY),
        args: useFlatSchema ? buildFlatSchema() : buildNestedSchema(),
        async execute(args, toolCtx) {
            if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
                throw new Error("Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.");
            }
            // Runtime enforcement: hard-reject when maxPasses already exhausted
            if (ctx.config.compress.autoLoop && ctx.state.autoLoopState) {
                const safeMaxPasses = sanitizeMaxPasses(ctx.config.compress.maxPasses);
                if (ctx.state.autoLoopState.passes.length >= safeMaxPasses) {
                    // Clear stale loop state and refuse the pass
                    const report = formatLoopReport(ctx.state.autoLoopState, "max_passes");
                    ctx.state.autoLoopActive = false;
                    ctx.state.autoLoopState = null;
                    return `Auto-loop complete: max passes (${safeMaxPasses}) reached. ${report}`;
                }
            }
            // Staleness guard: if autoLoopActive is set but autoLoopState
            // is missing, clear the flag to prevent sticky suppression
            if (ctx.state.autoLoopActive && !ctx.state.autoLoopState) {
                ctx.state.autoLoopActive = false;
            }
            try {
                await toolCtx.ask({
                    permission: "compress",
                    patterns: ["*"],
                    always: ["*"],
                    metadata: {},
                });
                const compressArgs = normalizeCompressArgs(args);
                validateCompressArgs(compressArgs);
                toolCtx.metadata({
                    title: `Compress: ${compressArgs.topic}`,
                });
                const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID);
                await ensureSessionInitialized(ctx.client, ctx.state, toolCtx.sessionID, ctx.logger, rawMessages, ctx.config.manualMode.enabled);
                assignMessageRefs(ctx.state, rawMessages);
                deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages);
                // supersedeWrites(ctx.state, ctx.logger, ctx.config, rawMessages)
                purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages);
                const searchContext = buildSearchContext(ctx.state, rawMessages);
                const { startReference, endReference } = resolveBoundaryIds(searchContext, ctx.state, compressArgs.content.startId, compressArgs.content.endId);
                const range = resolveRange(searchContext, startReference, endReference);
                const anchorMessageId = resolveAnchorMessageId(range.startReference);
                const parsedPlaceholders = parseBlockPlaceholders(compressArgs.content.summary);
                const missingRequiredBlockIds = validateSummaryPlaceholders(parsedPlaceholders, range.requiredBlockIds, range.startReference, range.endReference, searchContext.summaryByBlockId, mergeMode);
                const injected = injectBlockPlaceholders(compressArgs.content.summary, parsedPlaceholders, searchContext.summaryByBlockId, range.startReference, range.endReference, mergeMode, range.requiredBlockIds);
                const summaryWithUserMessages = appendProtectedUserMessages(injected.expandedSummary, range, searchContext, ctx.state, ctx.config.compress.protectUserMessages);
                const protectedToolsResult = await appendProtectedTools(ctx.client, ctx.state, ctx.config.experimental.allowSubAgents, summaryWithUserMessages, range, searchContext, ctx.config.compress.protectedTools, ctx.config.protectedFilePatterns, ctx.config.compress.protectedToolRetention, injected.consumedBlockIds);
                const finalSummaryResult = appendMissingBlockSummaries(protectedToolsResult.summary, missingRequiredBlockIds, searchContext.summaryByBlockId, injected.consumedBlockIds, mergeMode);
                const finalSummary = finalSummaryResult.expandedSummary;
                const blockId = allocateBlockId(ctx.state);
                const storedSummary = wrapCompressedSummary(blockId, finalSummary);
                const summaryTokens = countTokens(storedSummary);
                const applied = applyCompressionState(ctx.state, {
                    topic: compressArgs.topic,
                    startId: compressArgs.content.startId,
                    endId: compressArgs.content.endId,
                    compressMessageId: toolCtx.messageID,
                }, range, anchorMessageId, blockId, storedSummary, finalSummaryResult.consumedBlockIds, protectedToolsResult.protectedContentEntries);
                ctx.state.manualMode = ctx.state.manualMode ? "active" : false;
                await saveSessionState(ctx.state, ctx.logger);
                // Re-fetch messages to get post-compression token count (blocker: stale token basis)
                const postCompressionMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID);
                const postCompressionTokens = estimateContextTokens(postCompressionMessages, ctx.state.systemPromptTokens ?? 0);
                // Record this pass in loop state before evaluating continuation
                const preCompressionTokens = estimateContextTokens(rawMessages, ctx.state.systemPromptTokens ?? 0);
                if (ctx.config.compress.autoLoop && ctx.state.autoLoopState) {
                    ctx.state.autoLoopState.passes.push({
                        pass: ctx.state.autoLoopState.passes.length + 1,
                        tokensBefore: preCompressionTokens,
                        tokensAfter: postCompressionTokens,
                        rangesCompressed: 1,
                    });
                }
                else if (ctx.config.compress.autoLoop) {
                    // First pass — create autoLoopState with this pass's data so
                    // buildAutoLoopSuffix picks it up from ctx.state.autoLoopState.
                    const { contextTarget, maxPasses: cfgMaxPasses } = ctx.config.compress;
                    const modelContextLimit = ctx.state.modelContextLimit;
                    if (contextTarget && modelContextLimit) {
                        const targetTokens = calculateTargetTokens(modelContextLimit, contextTarget);
                        ctx.state.autoLoopState = {
                            sessionId: ctx.state.sessionId ?? "unknown",
                            passes: [
                                {
                                    pass: 1,
                                    tokensBefore: preCompressionTokens,
                                    tokensAfter: postCompressionTokens,
                                    rangesCompressed: 1,
                                },
                            ],
                            initialTokens: preCompressionTokens,
                            targetTokens,
                            maxPasses: sanitizeMaxPasses(cfgMaxPasses),
                        };
                    }
                }
                const params = getCurrentParams(ctx.state, rawMessages, ctx.logger);
                const totalSessionTokens = getCurrentTokenUsage(rawMessages);
                const sessionMessageIds = rawMessages
                    .filter((msg) => !(msg.info.role === "user" && isIgnoredUserMessage(msg)))
                    .map((msg) => msg.info.id);
                await sendCompressNotification(ctx.client, ctx.logger, ctx.config, ctx.state, toolCtx.sessionID, blockId, compressArgs.content.summary, summaryTokens, totalSessionTokens, sessionMessageIds, params);
                const suffix = buildAutoLoopSuffix(ctx, postCompressionTokens, postCompressionMessages);
                return (`Compressed ${applied.messageIds.length} messages into ${COMPRESSED_BLOCK_HEADER}.` +
                    suffix);
            }
            catch (error) {
                // Ensure autoLoopActive is reliably cleared on any error
                // to prevent sticky nudge suppression
                ctx.state.autoLoopActive = false;
                ctx.state.autoLoopState = null;
                throw error;
            }
        },
    });
}
//# sourceMappingURL=compress.js.map