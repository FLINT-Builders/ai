export type JSONValue = string | number | boolean | JSONObject | JSONArray;

interface JSONObject {
  [x: string]: JSONValue | undefined;
}

interface JSONArray extends Array<JSONValue> {}

export type AIAction<T = any, R = any> = (...args: T[]) => Promise<R>;
export type AIActions<T = any, R = any> = Record<string, AIAction<T, R>>;

/**
 * An AI state together with the server's signature over it.
 */
export type SignedAIState<T = unknown> = {
  state: T;
  signature: string;
};

/**
 * A delta between the AI state sent to an action and the AI state after the
 * action, together with the server's signature over the resulting AI state.
 */
export type SignedAIStateDelta = {
  delta: unknown;
  signature: string;
};

export type ServerWrappedAction = (
  // Sent by the client and therefore untrusted until it has been verified.
  signedAIState: unknown,
  ...args: unknown[]
) => Promise<[Promise<SignedAIStateDelta | undefined> | undefined, unknown]>;
export type ServerWrappedActions = Record<string, ServerWrappedAction>;

export type InternalAIProviderProps<AIState = any, UIState = any> = {
  children: React.ReactNode;
  initialUIState: UIState;
  initialAIState: AIState;
  initialAIStateSignature: string;
  initialAIStatePatch: undefined | Promise<SignedAIStateDelta | undefined>;
  wrappedActions: ServerWrappedActions;
  wrappedSyncUIState?: ServerWrappedAction;
};

export type AIProviderProps<AIState = any, UIState = any, Actions = any> = {
  children: React.ReactNode;
  initialAIState?: AIState;
  initialUIState?: UIState;
  /** $ActionTypes is only added for type inference and is never used at runtime **/
  $ActionTypes?: Actions;
};

export type AIProvider<AIState = any, UIState = any, Actions = any> = (
  props: AIProviderProps<AIState, UIState, Actions>,
) => Promise<React.ReactElement>;

export type InferAIState<T, Fallback> =
  T extends AIProvider<infer AIState, any, any> ? AIState : Fallback;
export type InferUIState<T, Fallback> =
  T extends AIProvider<any, infer UIState, any> ? UIState : Fallback;
export type InferActions<T, Fallback> =
  T extends AIProvider<any, any, infer Actions> ? Actions : Fallback;

export type InternalAIStateStorageOptions = {
  onSetAIState?: OnSetAIState<any>;
};

export type OnSetAIState<S> = ({
  key,
  state,
  done,
}: {
  key: string | number | symbol | undefined;
  state: S;
  done: boolean;
}) => void | Promise<void>;

export type OnGetUIState<S> = AIAction<void, S | undefined>;

export type ValueOrUpdater<T> = T | ((current: T) => T);

export type MutableAIState<AIState> = {
  get: () => AIState;
  update: (newState: ValueOrUpdater<AIState>) => void;
  done: ((newState: AIState) => void) | (() => void);
};
