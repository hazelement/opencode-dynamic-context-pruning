import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "./types";
import { type AutoLoopState } from "./compress-loop";
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
export declare function buildAutoLoopSuffix(ctx: ToolContext, currentTokens: number, rawMessages?: Array<{
    info: {
        role: string;
        id: string;
    };
    parts: any[];
}>, loopState?: AutoLoopState): string;
export declare function createCompressTool(ctx: ToolContext): ReturnType<typeof tool>;
//# sourceMappingURL=compress.d.ts.map