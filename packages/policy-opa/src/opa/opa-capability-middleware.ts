import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type { PolicyClient } from '../policy-client';
import { evaluatePolicy } from './evaluate-policy';

/**
 * Default OPA input shape passed to the capability-scoping rule.
 * Override with `toInput` if your Rego expects a different schema.
 */
export interface DefaultOpaCapabilityInput {
  messages: LanguageModelV4CallOptions['prompt'];
  providerOptions: LanguageModelV4CallOptions['providerOptions'];
}

/**
 * Tool names authorized for one model call, captured when the policy is
 * evaluated in `transformParams` and enforced on that call's output.
 */
interface CapabilityGrant {
  /** Names of the tools kept in the model request. */
  allowed: ReadonlySet<string>;
  /** Names of every tool the caller put in the model request. */
  requested: ReadonlySet<string>;
  /** Whether a provider tool was kept. */
  providerToolAllowed: boolean;
}

const DENY_ALL: CapabilityGrant = {
  allowed: new Set(),
  requested: new Set(),
  providerToolAllowed: false,
};

/**
 * Construct an experimental {@link LanguageModelV4Middleware} that scopes the
 * tools of every model call to an allowlist returned by OPA.
 *
 * The allowlist is enforced on both sides of the model call:
 *
 * 1. **Request.** `params.tools` is narrowed to the allowlist, so the model is
 *    not told about tools it cannot call.
 * 2. **Response.** Tool calls in the model output whose name is not in the
 *    allowlist computed for that same call are dropped (together with their
 *    streamed input, results, and approval requests), so `generateText`,
 *    `streamText`, and agents never execute them. A model can name a tool it
 *    was not offered, so request filtering alone is not a capability boundary.
 *
 * Use it alongside the per-call `toolApproval` gate (e.g. `opaPolicy`) for
 * defense in depth: the middleware withholds tools per caller, and the
 * approval gate checks each concrete call and its input.
 *
 * The OPA rule at `path` is expected to return either a `string[]` of allowed
 * tool names, or an object `{ tools: string[] }`. Function tools whose `name`
 * matches are kept; provider tools whose dotted `id` or bare `name` matches are
 * kept; everything else is dropped from `params.tools`.
 *
 * On a malformed result (or an OPA error), the middleware **fails closed**:
 * `params.tools` is set to `undefined`, so the model is told it has no tools
 * available, and every tool call it returns is dropped. Misconfiguration
 * should not silently widen capabilities.
 *
 * Provider-executed dynamic tool calls (for example MCP calls run by a provider
 * tool) are kept when a provider tool was allowed and the call does not reuse
 * the name of a tool from the request. The SDK never executes those locally.
 *
 * @example
 * ```ts
 * import { wrapLanguageModel } from 'ai';
 * import { wasmPolicyClient, opaCapabilityMiddleware } from '@ai-sdk/policy-opa';
 *
 * const client = await wasmPolicyClient({ wasm });
 *
 * const wrappedModel = wrapLanguageModel({
 *   model: anthropic('claude-sonnet-4-5'),
 *   middleware: opaCapabilityMiddleware({
 *     client,
 *     path: 'agent/tools/allowed',
 *   }),
 * });
 * ```
 */
export function opaCapabilityMiddleware(opts: {
  client: PolicyClient;
  path: string;
  toInput?: (args: {
    messages: LanguageModelV4CallOptions['prompt'];
    providerOptions: LanguageModelV4CallOptions['providerOptions'];
  }) => unknown;
}): LanguageModelV4Middleware {
  const { client, path, toInput } = opts;

  // `wrapLanguageModel` hands the exact object returned by `transformParams`
  // to `wrapGenerate` / `wrapStream`, so the grant is keyed on it. Params
  // without a grant are treated as deny-all.
  const grants = new WeakMap<LanguageModelV4CallOptions, CapabilityGrant>();

  function grant(
    params: LanguageModelV4CallOptions,
    value: CapabilityGrant,
  ): LanguageModelV4CallOptions {
    grants.set(params, value);
    return params;
  }

  return {
    specificationVersion: 'v4',
    async transformParams({ params }) {
      // No tools on the call: nothing to filter, and no tool may be called.
      if (params.tools == null || params.tools.length === 0) {
        return grant(params, DENY_ALL);
      }

      const requested = new Set(params.tools.map(t => t.name));

      const input =
        toInput?.({
          messages: params.prompt,
          providerOptions: params.providerOptions,
        }) ??
        ({
          messages: params.prompt,
          providerOptions: params.providerOptions,
        } satisfies DefaultOpaCapabilityInput);

      // Fail closed on evaluator error or a malformed allowlist: drop all
      // tools so a misconfiguration never silently widens capabilities.
      const outcome = await evaluatePolicy(client, path, input);
      if (!outcome.ok) {
        return grant(
          { ...params, tools: undefined },
          { ...DENY_ALL, requested },
        );
      }

      const allowedNames = extractAllowedNameSet(outcome.result);
      if (allowedNames == null) {
        return grant(
          { ...params, tools: undefined },
          { ...DENY_ALL, requested },
        );
      }

      let removed = false;
      const filtered = params.tools.filter(t => {
        // Function tools are keyed by `name`. Provider tools carry both a
        // dotted `id` (`<provider>.<tool>`) and a bare `name`; match either so
        // an allowlist authored with the bare name keeps the tool instead of
        // silently dropping it.
        const keep =
          t.type === 'function'
            ? allowedNames.has(t.name)
            : allowedNames.has(t.id) || allowedNames.has(t.name);
        if (!keep) removed = true;
        return keep;
      });

      // Tool calls are resolved by the tool's `name` (its key in the tool
      // set), for provider tools as well.
      const capability: CapabilityGrant = {
        allowed: new Set(filtered.map(t => t.name)),
        requested,
        providerToolAllowed: filtered.some(t => t.type === 'provider'),
      };

      // Preserve object identity when nothing was dropped so downstream
      // middleware can no-op on reference equality.
      if (!removed) return grant(params, capability);
      return grant({ ...params, tools: filtered }, capability);
    },

    async wrapGenerate({ doGenerate, params }) {
      const capability = grants.get(params) ?? DENY_ALL;
      const result = await doGenerate();

      const deniedToolCallIds = new Set<string>();
      for (const part of result.content) {
        if (part.type === 'tool-call' && !isToolCallAllowed(capability, part)) {
          deniedToolCallIds.add(part.toolCallId);
        }
      }

      const content = result.content.filter(part =>
        isContentAllowed(capability, deniedToolCallIds, part),
      );

      if (content.length === result.content.length) return result;
      return { ...result, content };
    },

    async wrapStream({ doStream, params }) {
      const capability = grants.get(params) ?? DENY_ALL;
      const { stream, ...rest } = await doStream();

      const deniedToolCallIds = new Set<string>();

      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV4StreamPart
          >({
            transform(part, controller) {
              switch (part.type) {
                case 'tool-input-start': {
                  if (
                    !isToolCallAllowed(capability, {
                      toolName: part.toolName,
                      providerExecuted: part.providerExecuted,
                      dynamic: part.dynamic,
                    })
                  ) {
                    deniedToolCallIds.add(part.id);
                    return;
                  }
                  break;
                }
                case 'tool-input-delta':
                case 'tool-input-end': {
                  if (deniedToolCallIds.has(part.id)) return;
                  break;
                }
                case 'tool-call': {
                  if (
                    deniedToolCallIds.has(part.toolCallId) ||
                    !isToolCallAllowed(capability, part)
                  ) {
                    deniedToolCallIds.add(part.toolCallId);
                    return;
                  }
                  break;
                }
                case 'tool-result':
                case 'tool-approval-request': {
                  if (!isContentAllowed(capability, deniedToolCallIds, part)) {
                    return;
                  }
                  break;
                }
              }
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}

function isToolCallAllowed(
  capability: CapabilityGrant,
  call: { toolName: string; providerExecuted?: boolean; dynamic?: boolean },
): boolean {
  if (capability.allowed.has(call.toolName)) return true;

  // Provider-executed dynamic tools (e.g. MCP tools behind a provider tool)
  // are not part of the request and are never executed by the SDK.
  return (
    call.providerExecuted === true &&
    call.dynamic === true &&
    capability.providerToolAllowed &&
    !capability.requested.has(call.toolName)
  );
}

function isContentAllowed(
  capability: CapabilityGrant,
  deniedToolCallIds: ReadonlySet<string>,
  part: LanguageModelV4Content,
): boolean {
  switch (part.type) {
    case 'tool-call':
      return (
        !deniedToolCallIds.has(part.toolCallId) &&
        isToolCallAllowed(capability, part)
      );
    case 'tool-result':
      return (
        !deniedToolCallIds.has(part.toolCallId) &&
        isToolCallAllowed(capability, {
          toolName: part.toolName,
          providerExecuted: true,
          dynamic: part.dynamic,
        })
      );
    case 'tool-approval-request':
      return !deniedToolCallIds.has(part.toolCallId);
    default:
      return true;
  }
}

function extractAllowedNameSet(result: unknown): Set<string> | null {
  const list = Array.isArray(result)
    ? result
    : result != null && typeof result === 'object'
      ? (result as { tools?: unknown }).tools
      : undefined;
  if (!Array.isArray(list)) return null;
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') return null;
    out.add(item);
  }
  return out;
}
