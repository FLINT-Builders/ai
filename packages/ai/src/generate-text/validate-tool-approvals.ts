import {
  asSchema,
  isExecutableTool,
  safeValidateTypes,
  type Context,
  type InferToolSetContext,
  type ModelMessage,
  type ToolApprovalRequest,
  type ToolSet,
} from '@ai-sdk/provider-utils';
import { InvalidToolApprovalError } from '../error/invalid-tool-approval-error';
import { InvalidToolApprovalSignatureError } from '../error/invalid-tool-approval-signature-error';
import { InvalidToolInputError } from '../error/invalid-tool-input-error';
import { ToolCallNotFoundForApprovalError } from '../error/tool-call-not-found-for-approval-error';
import { getOwn } from '../util/get-own';
import type { CollectedToolApprovals } from './collect-tool-approvals';
import { resolveToolApproval } from './resolve-tool-approval';
import { verifyToolApprovalSignature } from './tool-approval-signature';
import type { ToolApprovalConfiguration } from './tool-approval-configuration';
import type { TypedToolCall } from './tool-call';

/**
 * Re-validates approved tool approvals reconstructed from client-supplied
 * message history before they are executed. Checks HMAC signature (when
 * configured), input schema, and approval policy.
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
    CollectedToolApprovals<TOOLS> & { error: InvalidToolInputError }
  >;
}> {
  const approved: Array<CollectedToolApprovals<TOOLS>> = [];
  const denied: Array<CollectedToolApprovals<TOOLS>> = [];
  const invalid: Array<
    CollectedToolApprovals<TOOLS> & { error: InvalidToolInputError }
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

    const approvalStatus = await resolveToolApproval({
      tools,
      toolApproval,
      toolCall,
      messages,
      toolsContext,
      runtimeContext,
    });

    if (approvalStatus.type === 'denied') {
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

/**
 * Re-validates approval responses for provider-executed tools before they are
 * forwarded to the provider, which executes the tool on its side.
 *
 * Every forwarded approval in the client-supplied history is checked, not only
 * those in the last tool message, because the prompt conversion forwards all of
 * them. Signature errors throw (as for local tools). Approvals that fail input
 * validation or that the approval policy denies are rewritten to
 * `approved: false` in the returned messages.
 */
export async function validateProviderExecutedToolApprovals<
  TOOLS extends ToolSet,
  RUNTIME_CONTEXT extends Context | unknown | never,
>({
  messages,
  tools,
  toolApproval,
  toolsContext,
  runtimeContext,
  toolApprovalSecret,
}: {
  messages: ModelMessage[];
  tools: TOOLS | undefined;
  toolApproval: ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT> | undefined;
  toolsContext: InferToolSetContext<TOOLS>;
  runtimeContext: RUNTIME_CONTEXT;
  toolApprovalSecret?: string | Uint8Array;
}): Promise<ModelMessage[]> {
  // Keyed by client-supplied ids, so use prototype-less maps (see
  // collectToolApprovals).
  const toolCallsByToolCallId: Record<
    string,
    TypedToolCall<TOOLS>
  > = Object.create(null);
  const toolApprovalRequestsByApprovalId: Record<string, ToolApprovalRequest> =
    Object.create(null);
  for (const message of messages) {
    if (message.role === 'assistant' && typeof message.content !== 'string') {
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          toolCallsByToolCallId[part.toolCallId] = part as TypedToolCall<TOOLS>;
        } else if (part.type === 'tool-approval-request') {
          toolApprovalRequestsByApprovalId[part.approvalId] = part;
        }
      }
    }
  }

  let changed = false;
  const validatedMessages: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== 'tool') {
      validatedMessages.push(message);
      continue;
    }

    let messageChanged = false;
    const content: typeof message.content = [];

    for (const part of message.content) {
      if (
        part.type !== 'tool-approval-response' ||
        part.providerExecuted !== true ||
        part.approved === false
      ) {
        content.push(part);
        continue;
      }

      const approvalRequest = toolApprovalRequestsByApprovalId[part.approvalId];
      if (approvalRequest == null) {
        throw new InvalidToolApprovalError({ approvalId: part.approvalId });
      }

      const toolCall = toolCallsByToolCallId[approvalRequest.toolCallId];
      if (toolCall == null) {
        throw new ToolCallNotFoundForApprovalError({
          toolCallId: approvalRequest.toolCallId,
          approvalId: approvalRequest.approvalId,
        });
      }

      const { approvedToolApprovals, deniedToolApprovals } =
        await validateApprovedToolApprovals<TOOLS, RUNTIME_CONTEXT>({
          approvedToolApprovals: [
            { approvalRequest, approvalResponse: part, toolCall },
          ],
          tools,
          toolApproval,
          messages,
          toolsContext,
          runtimeContext,
          toolApprovalSecret,
        });

      if (approvedToolApprovals.length > 0) {
        content.push(part);
        continue;
      }

      messageChanged = true;
      content.push({
        ...part,
        approved: false,
        reason: deniedToolApprovals[0]?.approvalResponse.reason ?? part.reason,
      });
    }

    if (messageChanged) {
      changed = true;
      validatedMessages.push({ ...message, content });
    } else {
      validatedMessages.push(message);
    }
  }

  return changed ? validatedMessages : messages;
}
