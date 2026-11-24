export type RecordedEnvironmentValue = {
  environmentVariableName: string;
  value: string;
};

let activeRecording: RecordedEnvironmentValue[] | undefined;

/**
 * Notes that a setting or API key was read from an environment variable.
 * Only has an effect while `recordEnvironmentValues` is running.
 */
export function recordEnvironmentValue(
  environmentVariableName: string,
  value: string,
): void {
  activeRecording?.push({ environmentVariableName, value });
}

/**
 * Runs a synchronous function and returns its result together with the
 * environment variables that were read through `loadApiKey`, `loadSetting`,
 * or `loadOptionalSetting` while it ran.
 */
export function recordEnvironmentValues<T>(fn: () => T): {
  result: T;
  environmentValues: RecordedEnvironmentValue[];
} {
  const previousRecording = activeRecording;
  const environmentValues: RecordedEnvironmentValue[] = [];
  activeRecording = environmentValues;
  try {
    return { result: fn(), environmentValues };
  } finally {
    activeRecording = previousRecording;
  }
}
