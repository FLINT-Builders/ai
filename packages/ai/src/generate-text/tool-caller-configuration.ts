import {
  experimental_getToolCaller,
  type Context,
  type Experimental_ToolCallerBindOptions,
  type Experimental_ToolCallerTool,
  type InferToolSetContext,
  type ModelMessage,
  type Tool,
  type ToolSet,
  type UserModelMessage,
} from '@ai-sdk/provider-utils';
import { InvalidArgumentError } from '../error/invalid-argument-error';
import { getOwn } from '../util/get-own';
import { resolveUserDefinedToolApproval } from './resolve-tool-approval';
import type { ToolApprovalConfiguration } from './tool-approval-configuration';
import type { TypedToolCall } from './tool-call';

export const DIRECT_TOOL_CALL = 'AI_SDK_DIRECT_TOOL_CALL';

type ToolCallerName<TOOLS extends ToolSet> = {
  [NAME in keyof TOOLS]: TOOLS[NAME] extends Experimental_ToolCallerTool
    ? NAME
    : never;
}[keyof TOOLS] &
  string;

export type Experimental_ToolCallers<TOOLS extends ToolSet> = {
  [NAME in keyof TOOLS]?: ReadonlyArray<
    'AI_SDK_DIRECT_TOOL_CALL' | ToolCallerName<TOOLS>
  >;
};

export type ResolvedToolCallers = Record<string, ReadonlyArray<string>>;

export function resolveToolCallerConfiguration<TOOLS extends ToolSet>({
  tools,
  toolCallers,
  toolApproval,
}: {
  tools: TOOLS | undefined;
  toolCallers: Experimental_ToolCallers<TOOLS> | undefined;
  toolApproval?: ToolApprovalConfiguration<TOOLS, any> | undefined;
}): ResolvedToolCallers | undefined {
  if (tools == null || toolCallers == null) {
    return undefined;
  }

  const resolved: ResolvedToolCallers = {};

  for (const [toolName, callers] of Object.entries(toolCallers)) {
    if (!Object.prototype.hasOwnProperty.call(tools, toolName)) {
      throw new InvalidArgumentError({
        parameter: 'experimental_toolCallers',
        value: toolCallers,
        message: `unknown tool "${toolName}".`,
      });
    }

    if (!Array.isArray(callers)) {
      throw new InvalidArgumentError({
        parameter: 'experimental_toolCallers',
        value: toolCallers,
        message: `callers for tool "${toolName}" must be an array.`,
      });
    }

    const hasToolApprovalPolicy =
      typeof toolApproval === 'function' ||
      getOwn(toolApproval, toolName) != null;

    resolved[toolName] = callers.map(caller => {
      if (caller === DIRECT_TOOL_CALL) {
        return caller;
      }

      const callerDefinition =
        typeof caller === 'string' &&
        Object.prototype.hasOwnProperty.call(tools, caller)
          ? experimental_getToolCaller(tools[caller])
          : undefined;

      if (callerDefinition == null) {
        throw new InvalidArgumentError({
          parameter: 'experimental_toolCallers',
          value: toolCallers,
          message: `tool "${toolName}" contains an invalid caller.`,
        });
      }

      // A local caller executes the tool itself, so the call-level approval
      // policy is only enforced when the caller applies it.
      if (
        hasToolApprovalPolicy &&
        callerDefinition.type === 'local' &&
        callerDefinition.supportsToolApproval !== true
      ) {
        throw new InvalidArgumentError({
          parameter: 'experimental_toolCallers',
          value: toolCallers,
          message: `tool "${toolName}" has a toolApproval policy, but caller "${caller}" does not enforce toolApproval.`,
        });
      }

      return caller;
    });
  }

  return resolved;
}

export function prepareToolsForToolCallers<
  TOOLS extends ToolSet,
  RUNTIME_CONTEXT extends Context | unknown | never,
>({
  tools,
  toolCallers,
  toolApproval,
  toolsContext,
  runtimeContext,
}: {
  tools: ToolSet | undefined;
  toolCallers: ResolvedToolCallers | undefined;
  toolApproval: ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT> | undefined;
  toolsContext: InferToolSetContext<TOOLS>;
  runtimeContext: RUNTIME_CONTEXT;
}): {
  executionTools: ToolSet | undefined;
  modelTools: ToolSet | undefined;
  toolCallerMessages: UserModelMessage[];
} {
  if (tools == null || toolCallers == null) {
    return {
      executionTools: tools,
      modelTools: tools,
      toolCallerMessages: [],
    };
  }

  // Tools available to the runtime for execution.
  const executionTools: ToolSet = { ...tools };

  // Tools exposed directly to the model.
  const modelTools: ToolSet = { ...tools };

  // Tools routed through each local caller.
  const localToolsByCaller = new Map<string, ToolSet>();

  // User messages describing caller-accessible tools.
  const toolCallerMessages: UserModelMessage[] = [];

  for (const [toolName, callerNames] of Object.entries(toolCallers)) {
    const tool = executionTools[toolName];
    if (tool == null) {
      continue;
    }

    let availableDirectly = false;
    let availableToProvider = false;
    let preparedTool: Tool = tool;

    for (const callerName of callerNames) {
      if (callerName === DIRECT_TOOL_CALL) {
        availableDirectly = true;
        continue;
      }

      const caller = experimental_getToolCaller(executionTools[callerName]);
      if (caller == null) {
        continue;
      }

      if (caller.type === 'provider') {
        availableToProvider = true;
        preparedTool = {
          ...preparedTool,
          providerOptions: caller.prepareProviderOptions(
            preparedTool.providerOptions,
          ),
        } as Tool;
      } else {
        const localTools = localToolsByCaller.get(callerName) ?? {};
        localTools[toolName] = preparedTool;
        localToolsByCaller.set(callerName, localTools);
      }
    }

    executionTools[toolName] = preparedTool;

    if (availableDirectly || availableToProvider) {
      modelTools[toolName] = preparedTool;
    } else {
      delete modelTools[toolName];
    }
  }

  const resolveToolApproval: Experimental_ToolCallerBindOptions['resolveToolApproval'] =
    async ({ toolName, toolCallId, input, messages }) =>
      (await resolveUserDefinedToolApproval({
        tools: executionTools as TOOLS,
        toolCall: {
          type: 'tool-call',
          toolCallId,
          toolName,
          input,
        } as TypedToolCall<TOOLS>,
        toolApproval,
        messages: messages ?? [],
        toolsContext,
        runtimeContext,
      })) ?? { type: 'not-applicable' };

  for (const [callerName, callerTool] of Object.entries(executionTools)) {
    const caller = experimental_getToolCaller(callerTool);
    if (caller?.type !== 'local') {
      continue;
    }

    const callerTools = localToolsByCaller.get(callerName) ?? {};
    const boundCaller = caller.bind(callerTools, { resolveToolApproval });
    executionTools[callerName] = boundCaller;

    if (Object.prototype.hasOwnProperty.call(modelTools, callerName)) {
      if (caller.prepareModelMessage == null) {
        modelTools[callerName] = boundCaller;
      } else {
        const content = caller.prepareModelMessage(callerTools);
        if (content != null) {
          toolCallerMessages.push({ role: 'user', content });
        }
      }
    }
  }

  return { executionTools, modelTools, toolCallerMessages };
}

export function appendToolCallerMessages({
  messages,
  toolCallerMessages,
}: {
  messages: ModelMessage[];
  toolCallerMessages: UserModelMessage[];
}): ModelMessage[] {
  if (toolCallerMessages.length === 0) {
    return messages;
  }

  const latestUserText = messages.findLast(
    message => message.role === 'user' && typeof message.content === 'string',
  )?.content;
  const existingUserText = new Set(
    latestUserText == null ? [] : [latestUserText],
  );
  const additions = toolCallerMessages.filter(message => {
    if (
      typeof message.content !== 'string' ||
      existingUserText.has(message.content)
    ) {
      return false;
    }
    existingUserText.add(message.content);
    return true;
  });

  return additions.length === 0 ? messages : [...messages, ...additions];
}
