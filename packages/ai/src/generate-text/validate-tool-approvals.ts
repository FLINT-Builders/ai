import {
  asSchema,
  isExecutableTool,
  safeValidateTypes,
  type Context,
  type InferToolSetContext,
  type ModelMessage,
  type ToolSet,
} from '@ai-sdk/provider-utils';
import { InvalidToolApprovalSignatureError } from '../error/invalid-tool-approval-signature-error';
import { InvalidToolInputError } from '../error/invalid-tool-input-error';
import { getOwn } from '../util/get-own';
import type { CollectedToolApprovals } from './collect-tool-approvals';
import { resolveToolApproval } from './resolve-tool-approval';
import { verifyToolApprovalSignature } from './tool-approval-signature';
import type { ToolApprovalConfiguration } from './tool-approval-configuration';

/**
 * Re-validates approved tool approvals reconstructed from client-supplied
 * message history before they are executed. Checks HMAC signature (when
 * configured), input schema, and approval policy.
 *
 * `tools` must be the tools that are active for the request: the approved
 * approvals reference tools from this object, and callers must execute them
 * against the same object.
 *
 * An approved approval is only kept when the server-side policy still requires
 * user approval for the call or explicitly approves it. Calls for tools that
 * are not active, or whose policy is `not-applicable`, are reported as invalid
 * so that a client cannot run tools by forging an approval.
 */
export async function validateApprovedToolApprovals<
  TOOLS extends ToolSet,
  RUNTIME_CONTEXT extends Context | unknown | never,
>({
  approvedToolApprovals,
  tools,
  toolApproval,
  messages,
  toolsContext,
  runtimeContext,
  toolApprovalSecret,
}: {
  approvedToolApprovals: Array<CollectedToolApprovals<TOOLS>>;
  tools: TOOLS | undefined;
  toolApproval: ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT> | undefined;
  messages: ModelMessage[];
  toolsContext: InferToolSetContext<TOOLS>;
  runtimeContext: RUNTIME_CONTEXT;
  toolApprovalSecret?: string | Uint8Array;
}): Promise<{
  approvedToolApprovals: Array<CollectedToolApprovals<TOOLS>>;
  deniedToolApprovals: Array<CollectedToolApprovals<TOOLS>>;
  invalidToolApprovals: Array<
    CollectedToolApprovals<TOOLS> & { error: InvalidToolInputError | string }
  >;
}> {
  const approved: Array<CollectedToolApprovals<TOOLS>> = [];
  const denied: Array<CollectedToolApprovals<TOOLS>> = [];
  const invalid: Array<
    CollectedToolApprovals<TOOLS> & { error: InvalidToolInputError | string }
  > = [];

  for (const approval of approvedToolApprovals) {
    const { toolCall, approvalRequest } = approval;
    // Look up the tool by own property only: `toolName` comes from
    // client-supplied history, so a name matching an inherited object property
    // (e.g. `constructor`, `toString`) must resolve to "no such tool" rather
    // than a prototype value that would silently skip input validation below.
    const tool = getOwn(tools, toolCall.toolName);

    if (toolApprovalSecret != null) {
      if (approvalRequest.signature == null) {
        throw new InvalidToolApprovalSignatureError({
          approvalId: approvalRequest.approvalId,
          toolCallId: toolCall.toolCallId,
          reason: 'missing signature',
        });
      }

      const valid = await verifyToolApprovalSignature({
        secret: toolApprovalSecret,
        signature: approvalRequest.signature,
        approvalId: approvalRequest.approvalId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
      });

      if (!valid) {
        throw new InvalidToolApprovalSignatureError({
          approvalId: approvalRequest.approvalId,
          toolCallId: toolCall.toolCallId,
          reason: 'invalid signature',
        });
      }
    }

    if (isExecutableTool(tool) && tool.inputSchema != null) {
      const validation = await safeValidateTypes({
        value: toolCall.input,
        schema: asSchema(tool.inputSchema),
      });

      if (!validation.success) {
        invalid.push({
          ...approval,
          error: new InvalidToolInputError({
            toolName: toolCall.toolName,
            toolInput: JSON.stringify(toolCall.input),
            cause: validation.error,
          }),
        });
        continue;
      }
    }

    // A tool that is not active for this request has no approval policy in
    // effect, so the per-tool `toolApproval` entry must not be consulted.
    const approvalStatus =
      tool == null
        ? ({ type: 'not-applicable' } as const)
        : await resolveToolApproval({
            tools,
            toolApproval,
            toolCall,
            messages,
            toolsContext,
            runtimeContext,
          });

    if (approvalStatus.type === 'not-applicable') {
      invalid.push({
        ...approval,
        error: `Tool "${toolCall.toolName}" does not require approval`,
      });
    } else if (approvalStatus.type === 'denied') {
      denied.push({
        ...approval,
        approvalResponse: {
          ...approval.approvalResponse,
          approved: false,
          reason: approvalStatus.reason ?? approval.approvalResponse.reason,
        },
      });
    } else {
      approved.push(approval);
    }
  }

  return {
    approvedToolApprovals: approved,
    deniedToolApprovals: denied,
    invalidToolApprovals: invalid,
  };
}
