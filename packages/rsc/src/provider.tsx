// This file provides the AI context to all AI Actions via AsyncLocalStorage.

import * as React from 'react';
import { InternalAIProvider } from './rsc-shared.js';
import {
  withAIState,
  getAIStateDeltaPromise,
  sealMutableAIState,
} from './ai-state';
import { createSignedAIState, verifySignedAIState } from './ai-state-signature';
import type {
  ServerWrappedAction,
  ServerWrappedActions,
  SignedAIStateDelta,
  AIAction,
  AIActions,
  AIProvider,
  InternalAIStateStorageOptions,
  OnSetAIState,
  OnGetUIState,
} from './types';

async function innerAction(
  {
    action,
    options,
  }: { action: AIAction; options: InternalAIStateStorageOptions },
  signedState: unknown,
  ...args: unknown[]
) {
  'use server';
  // The AI state is held by the client between requests. Only state that was
  // signed by this server is accepted, and only the verified value is used.
  const state = await verifySignedAIState(signedState);
  return await withAIState(
    {
      state,
      options,
    },
    async () => {
      const result = await action(...args);
      sealMutableAIState();
      return [
        getAIStateDeltaPromise() as
          | Promise<SignedAIStateDelta | undefined>
          | undefined,
        result,
      ];
    },
  );
}

function wrapAction(action: AIAction, options: InternalAIStateStorageOptions) {
  return innerAction.bind(null, {
    action,
    options,
  }) as ServerWrappedAction;
}

export function createAI<
  AIState = any,
  UIState = any,
  Actions extends AIActions = {},
>({
  actions,
  initialAIState,
  initialUIState,

  onSetAIState,
  onGetUIState,
}: {
  actions: Actions;
  initialAIState?: AIState;
  initialUIState?: UIState;

  /**
   * This function is called whenever the AI state is updated by an Action.
   * You can use this to persist the AI state to a database, or to send it to a
   * logging service.
   */
  onSetAIState?: OnSetAIState<AIState>;

  /**
   * This function is used to retrieve the UI state based on the AI state.
   * For example, to render the initial UI state based on a given AI state, or
   * to sync the UI state when the application is already loaded.
   *
   * If returning `undefined`, the client side UI state will not be updated.
   *
   * This function must be annotated with the `"use server"` directive.
   *
   * @example
   * ```tsx
   * onGetUIState: async () => {
   *   'use server';
   *
   *   const currentAIState = getAIState();
   *   const externalAIState = await loadAIStateFromDatabase();
   *
   *   if (currentAIState === externalAIState) return undefined;
   *
   *   // Update current AI state and return the new UI state
   *   const state = getMutableAIState()
   *   state.done(externalAIState)
   *
   *   return <div>...</div>;
   * }
   * ```
   */
  onGetUIState?: OnGetUIState<UIState>;
}) {
  // Wrap all actions with our HoC.
  const wrappedActions: ServerWrappedActions = {};
  for (const name in actions) {
    wrappedActions[name] = wrapAction(actions[name], {
      onSetAIState,
    });
  }

  const wrappedSyncUIState = onGetUIState
    ? wrapAction(onGetUIState, {})
    : undefined;

  const AI: AIProvider<AIState, UIState, Actions> = async props => {
    if ('useState' in React) {
      // This file must be running on the React Server layer.
      // Ideally we should be using `import "server-only"` here but we can have a
      // more customized error message with this implementation.
      throw new Error(
        'This component can only be used inside Server Components.',
      );
    }

    let uiState = props.initialUIState ?? initialUIState;
    let aiState = props.initialAIState ?? initialAIState;
    let aiStateDelta = undefined;

    const signedAIState = await createSignedAIState(aiState);

    if (wrappedSyncUIState) {
      const [newAIStateDelta, newUIState] =
        await wrappedSyncUIState(signedAIState);
      if (newUIState !== undefined) {
        aiStateDelta = newAIStateDelta;
        uiState = newUIState as UIState;
      }
    }

    return (
      <InternalAIProvider
        wrappedActions={wrappedActions}
        wrappedSyncUIState={wrappedSyncUIState}
        initialUIState={uiState}
        initialAIState={aiState}
        initialAIStateSignature={signedAIState.signature}
        initialAIStatePatch={aiStateDelta}
      >
        {props.children}
      </InternalAIProvider>
    );
  };

  return AI;
}
