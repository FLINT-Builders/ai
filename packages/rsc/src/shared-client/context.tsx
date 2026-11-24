/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import * as React from 'react';

import * as jsondiffpatch from 'jsondiffpatch';
import { isFunction } from '../util/is-function';
import type {
  AIProvider,
  InferActions,
  InferAIState,
  InferUIState,
  InternalAIProviderProps,
  SignedAIState,
  SignedAIStateDelta,
  ValueOrUpdater,
} from '../types';

const InternalUIStateProvider = React.createContext<null | any>(null);
const InternalAIStateProvider = React.createContext<undefined | any>(undefined);
const InternalActionProvider = React.createContext<null | any>(null);
const InternalSyncUIStateProvider = React.createContext<null | any>(null);

function applySignedDelta(
  signedState: SignedAIState,
  signedDelta: SignedAIStateDelta,
): SignedAIState {
  return {
    state:
      signedDelta.delta === undefined
        ? signedState.state
        : jsondiffpatch.patch(
            jsondiffpatch.clone(signedState.state),
            signedDelta.delta as jsondiffpatch.Delta,
          ),
    signature: signedDelta.signature,
  };
}

export function InternalAIProvider({
  children,
  initialUIState,
  initialAIState,
  initialAIStateSignature,
  initialAIStatePatch,
  wrappedActions,
  wrappedSyncUIState,
}: InternalAIProviderProps) {
  if (!('use' in React)) {
    throw new Error('Unsupported React version.');
  }

  const uiState = React.useState(initialUIState);
  const setUIState = uiState[1];

  const resolvedInitialAIStatePatch: SignedAIStateDelta | undefined =
    initialAIStatePatch ? (React as any).use(initialAIStatePatch) : undefined;
  const initialSignedAIState = React.useMemo(() => {
    const signedState = {
      state: initialAIState,
      signature: initialAIStateSignature,
    };
    return resolvedInitialAIStatePatch
      ? applySignedDelta(signedState, resolvedInitialAIStatePatch)
      : signedState;
  }, [initialAIState, initialAIStateSignature, resolvedInitialAIStatePatch]);

  const aiState = React.useState(initialSignedAIState.state);
  const setAIState = aiState[1];

  // The server only accepts AI state that it has signed, so actions receive the
  // latest state returned by the server rather than the client's AI state,
  // which can also be changed on the client with `useAIState`.
  const signedAIStateRef = React.useRef<SignedAIState>(initialSignedAIState);

  const clientWrappedActions = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(wrappedActions).map(([key, action]) => [
          key,
          async (...args: any) => {
            const signedAIStateSnapshot = signedAIStateRef.current;
            const [aiStateDelta, result] = await action(
              signedAIStateSnapshot,
              ...args,
            );
            (async () => {
              const signedDelta = await aiStateDelta;
              if (signedDelta !== undefined) {
                signedAIStateRef.current = applySignedDelta(
                  signedAIStateSnapshot,
                  signedDelta,
                );
                const delta = signedDelta.delta;
                if (delta !== undefined) {
                  setAIState((currentState: any) =>
                    jsondiffpatch.patch(
                      jsondiffpatch.clone(currentState),
                      delta as jsondiffpatch.Delta,
                    ),
                  );
                }
              }
            })();
            return result;
          },
        ]),
      ),
    [wrappedActions],
  );

  const clientWrappedSyncUIStateAction = React.useMemo(() => {
    if (!wrappedSyncUIState) {
      return () => {};
    }

    return async () => {
      const signedAIStateSnapshot = signedAIStateRef.current;
      const [aiStateDelta, uiState] = await wrappedSyncUIState!(
        signedAIStateSnapshot,
      );

      if (uiState !== undefined) {
        setUIState(uiState);
      }

      const signedDelta = await aiStateDelta;
      if (signedDelta !== undefined) {
        const patchedSignedAIState = applySignedDelta(
          signedAIStateSnapshot,
          signedDelta,
        );
        signedAIStateRef.current = patchedSignedAIState;
        if (signedDelta.delta !== undefined) {
          setAIState(patchedSignedAIState.state);
        }
      }
    };
  }, [wrappedSyncUIState]);

  return (
    <InternalAIStateProvider.Provider value={aiState}>
      <InternalUIStateProvider.Provider value={uiState}>
        <InternalActionProvider.Provider value={clientWrappedActions}>
          <InternalSyncUIStateProvider.Provider
            value={clientWrappedSyncUIStateAction}
          >
            {children}
          </InternalSyncUIStateProvider.Provider>
        </InternalActionProvider.Provider>
      </InternalUIStateProvider.Provider>
    </InternalAIStateProvider.Provider>
  );
}

export function useUIState<AI extends AIProvider = any>() {
  type T = InferUIState<AI, any>;

  const state = React.useContext<
    [T, (v: T | ((v_: T) => T)) => void] | null | undefined
  >(InternalUIStateProvider);
  if (state === null) {
    throw new Error('`useUIState` must be used inside an <AI> provider.');
  }
  if (!Array.isArray(state)) {
    throw new Error('Invalid state');
  }
  if (state[0] === undefined) {
    throw new Error(
      '`initialUIState` must be provided to `createAI` or `<AI>`',
    );
  }
  return state;
}

// TODO: How do we avoid causing a re-render when the AI state changes but you
// are only listening to a specific key? We need useSES perhaps?
function useAIState<AI extends AIProvider = any>(): [
  InferAIState<AI, any>,
  (newState: ValueOrUpdater<InferAIState<AI, any>>) => void,
];
function useAIState<AI extends AIProvider = any>(
  key: keyof InferAIState<AI, any>,
): [
  InferAIState<AI, any>[typeof key],
  (newState: ValueOrUpdater<InferAIState<AI, any>[typeof key]>) => void,
];
function useAIState<AI extends AIProvider = any>(
  ...args: [] | [keyof InferAIState<AI, any>]
) {
  type T = InferAIState<AI, any>;

  const state = React.useContext<
    [T, (newState: ValueOrUpdater<T>) => void] | null | undefined
  >(InternalAIStateProvider);
  if (state === null) {
    throw new Error('`useAIState` must be used inside an <AI> provider.');
  }
  if (!Array.isArray(state)) {
    throw new Error('Invalid state');
  }
  if (state[0] === undefined) {
    throw new Error(
      '`initialAIState` must be provided to `createAI` or `<AI>`',
    );
  }
  if (args.length >= 1 && typeof state[0] !== 'object') {
    throw new Error(
      'When using `useAIState` with a key, the AI state must be an object.',
    );
  }

  const key = args[0];
  const setter = React.useCallback(
    typeof key === 'undefined'
      ? state[1]
      : (newState: ValueOrUpdater<T>) => {
          if (isFunction(newState)) {
            return state[1](s => {
              return { ...s, [key]: newState(s[key]) };
            });
          } else {
            return state[1](s => ({ ...s, [key]: newState }));
          }
        },
    [key],
  );

  if (args.length === 0) {
    return state;
  } else {
    return [state[0][args[0]], setter];
  }
}

export function useActions<AI extends AIProvider = any>() {
  type T = InferActions<AI, any>;

  const actions = React.useContext<T>(InternalActionProvider);
  return actions;
}

export function useSyncUIState() {
  const syncUIState = React.useContext<() => Promise<void>>(
    InternalSyncUIStateProvider,
  );

  if (syncUIState === null) {
    throw new Error('`useSyncUIState` must be used inside an <AI> provider.');
  }

  return syncUIState;
}

export { useAIState };
