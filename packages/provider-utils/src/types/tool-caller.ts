import type { ModelMessage } from './model-message';
import type { ProviderOptions } from './provider-options';
import type { Tool } from './tool';
import type { ToolSet } from './tool-set';

/**
 * Approval decision for a tool call made through a local tool caller.
 *
 * - `not-applicable`: no call-level approval policy applies; the caller falls
 *   back to the tool's own `needsApproval` setting.
 * - `approved`: the call may run without asking for approval.
 * - `denied`: the call must be rejected without running the tool.
 * - `user-approval`: the call requires approval, exactly as if the tool's
 *   `needsApproval` setting resolved to `true`.
 */
export type ToolCallerToolApprovalStatus = {
  type: 'not-applicable' | 'approved' | 'denied' | 'user-approval';
  reason?: string;
};

export type ToolCallerBindOptions = {
  /**
   * Resolves the call-level approval policy (`toolApproval`) of the
   * surrounding generation for a tool call made by the caller.
   *
   * Local callers must call it with the validated input of every tool call
   * before executing the tool, and must execute the tool with that same input.
   */
  resolveToolApproval: (toolCall: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    messages?: ModelMessage[];
  }) => Promise<ToolCallerToolApprovalStatus>;
};

export type ToolCallerDefinition =
  | {
      type: 'local';
      bind: (tools: ToolSet, options: ToolCallerBindOptions) => Tool;
      /**
       * Declares that the bound caller enforces `resolveToolApproval` for every
       * tool call. Tools with a call-level approval policy can only be routed
       * through local callers that set this to `true`.
       */
      supportsToolApproval?: boolean;
      /**
       * Creates a provider-agnostic user message that describes the tools
       * available through this caller. When present, the unbound caller tool
       * remains model-visible so its definition stays stable, while the
       * returned message is added to the conversation when its content has
       * not already been announced.
       */
      prepareModelMessage?: (tools: ToolSet) => string | undefined;
    }
  | {
      type: 'provider';
      prepareProviderOptions: (
        providerOptions: ProviderOptions | undefined,
      ) => ProviderOptions;
    };

export type ToolCallerTool<TOOL extends Tool = Tool> = TOOL & {
  readonly experimental_toolCaller: ToolCallerDefinition;
};

export function toolCaller<TOOL extends Tool>(
  tool: TOOL,
  definition: ToolCallerDefinition,
): ToolCallerTool<TOOL> {
  return Object.defineProperty({ ...tool }, 'experimental_toolCaller', {
    value: definition,
  }) as ToolCallerTool<TOOL>;
}

export function getToolCaller(
  tool: Tool | undefined,
): ToolCallerDefinition | undefined {
  return (tool as ToolCallerTool | undefined)?.experimental_toolCaller;
}
