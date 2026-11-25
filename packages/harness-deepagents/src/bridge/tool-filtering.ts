import {
  AIMessage,
  ToolMessage,
  type ToolCall,
} from '@langchain/core/messages';
import { GENERAL_PURPOSE_SUBAGENT, type createDeepAgent } from 'deepagents';
import type { StartMessage } from '../deepagents-bridge-protocol';
import {
  isBuiltinToolIncluded,
  NATIVE_TOOL_KIND,
  toCommonName,
} from './approvals';

type DeepAgentsParams = NonNullable<Parameters<typeof createDeepAgent>[0]>;

type DeepAgentsMiddleware = NonNullable<DeepAgentsParams['middleware']>[number];

type DeepAgentsSubagent = NonNullable<DeepAgentsParams['subagents']>[number];

type DeepAgentsState = {
  messages: unknown[];
};

type DeepAgentsMiddlewareUpdate = {
  messages: unknown[];
  jumpTo?: 'model';
};

const MIDDLEWARE_BRAND = Symbol.for('AgentMiddleware');

function getBuiltinToolFilteringDenialReason(input: {
  toolName: string;
}): string {
  return `Tool '${input.toolName}' is inactive due to the HarnessAgent tool filtering policy.`;
}

function stringifyToolInput(input: unknown): string {
  return JSON.stringify(input ?? {});
}

function isNativeBuiltinToolCall(input: { toolCall: ToolCall }): boolean {
  return Object.keys(NATIVE_TOOL_KIND).includes(input.toolCall.name);
}

function isInactiveBuiltinToolCall(input: {
  toolCall: ToolCall;
  builtinToolFiltering: StartMessage['builtinToolFiltering'];
}): boolean {
  return (
    isNativeBuiltinToolCall({ toolCall: input.toolCall }) &&
    !isBuiltinToolIncluded({
      nativeName: input.toolCall.name,
      toolFiltering: input.builtinToolFiltering,
    })
  );
}

export function createBuiltinToolFilteringMiddleware(input: {
  builtinToolFiltering: StartMessage['builtinToolFiltering'];
  emit: (event: Record<string, unknown>) => void;
}): DeepAgentsMiddleware | undefined {
  if (input.builtinToolFiltering == null) return undefined;

  return {
    [MIDDLEWARE_BRAND]: true,
    name: 'HarnessBuiltinToolFilteringMiddleware',
    afterModel: {
      canJumpTo: ['model'],
      hook: (
        state: DeepAgentsState,
      ): DeepAgentsMiddlewareUpdate | undefined => {
        const lastMessage = [...state.messages]
          .reverse()
          .find(message => AIMessage.isInstance(message));

        if (!lastMessage?.tool_calls?.length) return undefined;

        let hasActiveToolCalls = false;
        const deniedToolMessages: ToolMessage[] = [];

        for (const toolCall of lastMessage.tool_calls) {
          if (
            !isInactiveBuiltinToolCall({
              toolCall,
              builtinToolFiltering: input.builtinToolFiltering,
            })
          ) {
            hasActiveToolCalls = true;
            continue;
          }

          const nativeName = toolCall.name;
          toolCall.id ??= `${nativeName}-filtered-${deniedToolMessages.length}`;
          const toolName = toCommonName(nativeName);
          const reason = getBuiltinToolFilteringDenialReason({ toolName });

          input.emit({
            type: 'tool-call',
            toolCallId: toolCall.id,
            toolName,
            input: stringifyToolInput(toolCall.args),
            providerExecuted: true,
            nativeName,
          });
          input.emit({
            type: 'tool-result',
            toolCallId: toolCall.id,
            toolName,
            result: reason,
          });

          deniedToolMessages.push(
            new ToolMessage({
              content: reason,
              name: nativeName,
              tool_call_id: toolCall.id,
              status: 'error',
            }),
          );
        }

        if (deniedToolMessages.length === 0) return undefined;

        return {
          messages: [lastMessage, ...deniedToolMessages],
          ...(hasActiveToolCalls ? {} : { jumpTo: 'model' }),
        };
      },
    },
  } as DeepAgentsMiddleware;
}

// Deep Agents only merges custom middleware into its default general-purpose
// subagent by name, so that subagent would run filtered built-ins unchecked.
export function createBuiltinToolFilteringSubagents(input: {
  builtinToolFilteringMiddleware: DeepAgentsMiddleware | undefined;
  tools: DeepAgentsParams['tools'];
  skills: string[] | undefined;
}): DeepAgentsSubagent[] | undefined {
  if (input.builtinToolFilteringMiddleware == null) return undefined;
  return [
    {
      ...GENERAL_PURPOSE_SUBAGENT,
      tools: input.tools,
      middleware: [input.builtinToolFilteringMiddleware],
      ...(input.skills?.length ? { skills: input.skills } : {}),
    } as DeepAgentsSubagent,
  ];
}
