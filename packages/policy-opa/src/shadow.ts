import {
  validateTypes,
  type Context,
  type FlexibleSchema,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from '@ai-sdk/provider-utils';
import type { ToolApprovalConfiguration } from 'ai';
import type { PolicyDecision } from './policy-decision';

interface ApprovalTool {
  contextSchema?: FlexibleSchema<unknown>;
  needsApproval?:
    | boolean
    | ((
        input: unknown,
        options: {
          toolCallId: string;
          messages: ModelMessage[];
          context: unknown;
        },
      ) => boolean | PromiseLike<boolean>);
}

interface GenericApprovalArgs {
  toolCall: { toolName: string; toolCallId: string; input: unknown };
  tools: unknown;
  toolsContext: unknown;
  runtimeContext: unknown;
  messages: ModelMessage[];
}

/**
 * Event emitted by {@link shadow} every time the wrapped policy is evaluated.
 *
 * Compare `decision` and `effective` to see what would have happened
 * differently if the policy were enforcing: any record where they disagree
 * is a tool call that shadow mode is letting through but enforce mode would
 * have blocked or escalated.
 */
export interface PolicyDecisionEvent {
  /** Identifying info from the tool call being evaluated. */
  toolCall: { toolName: string; toolCallId: string; input: unknown };
  /** The decision the wrapped policy returned, normalized to the object form. */
  decision: PolicyDecision;
  /** Whether the SDK will act on `decision` (true) or override to allow (false). */
  enforced: boolean;
  /** The decision the SDK actually acts on. When enforcing, equals `decision`
   *  unless the policy had no opinion, in which case it is the tool's own
   *  `needsApproval` result. In shadow mode it is `{ type: 'user-approval' }`
   *  when the tool's `needsApproval` requires it, otherwise
   *  `{ type: 'approved' }`. */
  effective: PolicyDecision;
  /** ISO 8601 timestamp of the evaluation. */
  timestamp: string;
}

/**
 * Wrap a `toolApproval` in shadow mode so the policy is evaluated and the
 * decision is reported via `onDecision`, but the SDK is told the call is
 * approved regardless of what the policy said.
 *
 * A tool's own `needsApproval` is never weakened by the wrapper. In shadow
 * mode, a tool whose `needsApproval` requires it still gets
 * `{ type: 'user-approval' }`. When enforcing and the policy has no opinion
 * (`undefined` or `not-applicable`), the tool's `needsApproval` decides.
 *
 * Use this when you are rolling out a new policy and want to see what it
 * *would* deny before letting it actually deny anything in production. Wire
 * `onDecision` to your logger / metrics pipeline, run for a while, inspect
 * the events where `decision.type !== 'approved'`, fix the policy, then
 * flip `enforce: true` to graduate.
 *
 * @example
 * ```ts
 * import { shadow } from '@ai-sdk/policy-opa';
 * import { opaPolicy, wasmPolicyClient } from '@ai-sdk/policy-opa';
 *
 * const client = await wasmPolicyClient({ wasm });
 *
 * const toolApproval = shadow(
 *   opaPolicy({ client, path: 'agent/call/decision' }),
 *   {
 *     enforce: process.env.ENFORCE_POLICY === 'true',
 *     onDecision: (event) => {
 *       logger.info('policy.decision', {
 *         tool: event.toolCall.toolName,
 *         decision: event.decision.type,
 *         enforced: event.enforced,
 *         wouldBlock: event.decision.type === 'denied',
 *       });
 *     },
 *   },
 * );
 * ```
 */
export function shadow<
  TOOLS extends Record<string, Tool>,
  RUNTIME_CONTEXT extends Context | unknown | never = unknown,
>(
  approval: ToolApprovalConfiguration<TOOLS & ToolSet, RUNTIME_CONTEXT>,
  opts: {
    /** When true, the SDK acts on the policy's decision. When false (default),
     *  the SDK is told every call is approved, except calls the tool's own
     *  `needsApproval` holds for user approval. */
    enforce?: boolean;
    /** Invoked once per evaluated tool call with the captured decision. */
    onDecision?: (event: PolicyDecisionEvent) => void | Promise<void>;
  } = {},
): ToolApprovalConfiguration<TOOLS & ToolSet, RUNTIME_CONTEXT> {
  const enforce = opts.enforce === true;
  const { onDecision } = opts;

  const wrapped = async (args: GenericApprovalArgs) => {
    const tool = getOwn(args.tools, args.toolCall.toolName) as
      | ApprovalTool
      | undefined;

    const raw = await evaluateApproval(approval, args, tool);
    const decision = normalizePolicyDecision(raw);

    let effective: PolicyDecision;
    if (enforce) {
      effective =
        decision.type === 'not-applicable'
          ? await evaluateToolNeedsApproval(tool, args)
          : decision;
    } else {
      const toolLevel = await evaluateToolNeedsApproval(tool, args);
      effective =
        toolLevel.type === 'user-approval' ? toolLevel : { type: 'approved' };
    }

    if (onDecision) {
      const event: PolicyDecisionEvent = {
        toolCall: {
          toolName: args.toolCall.toolName,
          toolCallId: args.toolCall.toolCallId,
          input: args.toolCall.input,
        },
        decision,
        enforced: enforce,
        effective,
        timestamp: new Date().toISOString(),
      };
      // Fire-and-forget so a slow or throwing logger does not block the model.
      void (async () => {
        try {
          await onDecision(event);
        } catch {
          // Swallow errors from telemetry; enforcement must not depend on it.
        }
      })();
    }

    return effective;
  };

  // `wrapped` is typed against the erased `GenericApprovalArgs`; TS can't prove
  // that matches the SDK's per-tool-set function arm, so bridge it here.
  return wrapped as unknown as ToolApprovalConfiguration<
    TOOLS & ToolSet,
    RUNTIME_CONTEXT
  >;
}

async function evaluateApproval(
  approval: unknown,
  args: GenericApprovalArgs,
  tool: ApprovalTool | undefined,
): Promise<unknown> {
  if (typeof approval === 'function') {
    return await (
      approval as (a: GenericApprovalArgs) => Promise<unknown> | unknown
    )(args);
  }

  // Own-property check so a tool name that matches an inherited object
  // property (e.g. `constructor`, `toString`, `valueOf`) is treated as
  // unconfigured instead of resolving to a prototype value and being invoked
  // as if it were a per-tool approval callback.
  const perTool = getOwn(approval, args.toolCall.toolName);
  if (perTool == null) return undefined;
  if (typeof perTool === 'function') {
    return await (
      perTool as (
        input: unknown,
        options: {
          toolCallId: string;
          messages: ModelMessage[];
          toolContext: unknown;
          runtimeContext: unknown;
        },
      ) => Promise<unknown> | unknown
    )(args.toolCall.input, {
      toolCallId: args.toolCall.toolCallId,
      messages: args.messages,
      toolContext: await validateToolContext(tool, args),
      runtimeContext: args.runtimeContext,
    });
  }
  return perTool;
}

/**
 * The tool's own `needsApproval` requirement, resolved the same way the SDK
 * resolves it when `toolApproval` has no opinion on the call.
 */
async function evaluateToolNeedsApproval(
  tool: ApprovalTool | undefined,
  args: GenericApprovalArgs,
): Promise<PolicyDecision> {
  if (tool?.needsApproval == null) return { type: 'not-applicable' };

  const needsApproval =
    typeof tool.needsApproval === 'function'
      ? await tool.needsApproval(args.toolCall.input, {
          toolCallId: args.toolCall.toolCallId,
          messages: args.messages,
          context: await validateToolContext(tool, args),
        })
      : tool.needsApproval;

  return needsApproval ? { type: 'user-approval' } : { type: 'not-applicable' };
}

async function validateToolContext(
  tool: ApprovalTool | undefined,
  args: GenericApprovalArgs,
): Promise<unknown> {
  const toolName = args.toolCall.toolName;
  const context = getOwn(args.toolsContext, toolName);
  if (tool?.contextSchema == null) return context;

  return await validateTypes({
    value: context,
    schema: tool.contextSchema,
    context: { field: 'tool context', entityName: toolName },
  });
}

function getOwn(obj: unknown, key: string): unknown {
  return obj != null &&
    typeof obj === 'object' &&
    Object.prototype.hasOwnProperty.call(obj, key)
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function normalizePolicyDecision(status: unknown): PolicyDecision {
  if (status == null) return { type: 'not-applicable' };
  if (typeof status === 'string') {
    if (
      status === 'approved' ||
      status === 'denied' ||
      status === 'user-approval' ||
      status === 'not-applicable'
    ) {
      return { type: status };
    }
    return { type: 'not-applicable' };
  }
  if (typeof status === 'object' && 'type' in (status as object)) {
    return status as PolicyDecision;
  }
  return { type: 'not-applicable' };
}
