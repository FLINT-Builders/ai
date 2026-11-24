import type { Tool } from '@ai-sdk/provider-utils';
import type { ToolApprovalStatus } from 'ai';
import type { HarnessV1PermissionMode } from '../../v1';
import type { HarnessAgentToolApprovalConfiguration } from '../harness-agent-settings';

export const DEFAULT_PERMISSION_MODE: HarnessV1PermissionMode =
  'allow-all' as const;

export function resolvePermissionMode(input: {
  permissionMode: HarnessV1PermissionMode | undefined;
}): HarnessV1PermissionMode {
  return input.permissionMode ?? DEFAULT_PERMISSION_MODE;
}

export function permissionModeNeedsBuiltinSupport(input: {
  permissionMode: HarnessV1PermissionMode;
}): boolean {
  return input.permissionMode !== 'allow-all';
}

export type CustomToolApprovalDecision =
  | { readonly type: 'allow'; readonly reason?: string }
  | { readonly type: 'deny'; readonly reason?: string }
  | { readonly type: 'request' };

/**
 * Resolves the approval decision for a host-executed tool call. The agent-level
 * `toolApproval` entry takes precedence; without one, the tool's own
 * `needsApproval` applies, as in AI SDK `resolveToolApproval`.
 *
 * `toolInput` must be the exact input the tool is executed with when the
 * decision is `allow`.
 */
export async function resolveCustomToolApproval(input: {
  toolName: string;
  toolCallId: string;
  toolApproval: HarnessAgentToolApprovalConfiguration | undefined;
  tool: Tool | undefined;
  toolInput: unknown;
  isToolInputValid: boolean;
}): Promise<CustomToolApprovalDecision> {
  const configuredStatus =
    input.toolApproval != null &&
    Object.prototype.hasOwnProperty.call(input.toolApproval, input.toolName)
      ? input.toolApproval[input.toolName]
      : undefined;
  const status =
    configuredStatus != null
      ? normalizeToolApprovalStatus({ status: configuredStatus })
      : await resolveToolDefinedApprovalStatus(input);

  switch (status.type) {
    case 'not-applicable':
    case 'approved':
      return { type: 'allow', reason: status.reason };
    case 'denied':
      return { type: 'deny', reason: status.reason };
    case 'user-approval':
      return { type: 'request' };
  }
}

async function resolveToolDefinedApprovalStatus(input: {
  toolCallId: string;
  tool: Tool | undefined;
  toolInput: unknown;
  isToolInputValid: boolean;
}): Promise<Exclude<ToolApprovalStatus, string | undefined>> {
  const needsApproval = input.tool?.needsApproval;
  if (needsApproval == null || needsApproval === false) {
    return { type: 'not-applicable' };
  }
  // An input that failed schema validation cannot be judged by the tool's
  // approval function, so it always needs a user decision.
  if (typeof needsApproval !== 'function' || !input.isToolInputValid) {
    return { type: 'user-approval' };
  }
  const approvalRequired = await needsApproval(input.toolInput, {
    toolCallId: input.toolCallId,
    messages: [],
    context: undefined,
  });
  return approvalRequired
    ? { type: 'user-approval' }
    : { type: 'not-applicable' };
}

function normalizeToolApprovalStatus(input: {
  status: ToolApprovalStatus | undefined;
}): Exclude<ToolApprovalStatus, string | undefined> {
  if (input.status === undefined) return { type: 'not-applicable' };
  if (typeof input.status === 'string') return { type: input.status };
  return input.status;
}
