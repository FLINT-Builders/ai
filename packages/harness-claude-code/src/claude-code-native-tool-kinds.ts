/*
 * Approval kind of every native Claude Code tool, keyed by native name. The
 * in-sandbox bridge gates tools with this table under `allow-reads` and
 * `allow-edits`, and the host catalog's `toolUseKind` values are checked
 * against it at compile time. Keep this module free of imports: it is bundled
 * into the bridge.
 */
export type ClaudeCodeNativeToolKind = 'readonly' | 'edit' | 'bash';

export const CLAUDE_CODE_NATIVE_TOOL_KINDS = {
  Read: 'readonly',
  Glob: 'readonly',
  Grep: 'readonly',
  WebSearch: 'readonly',
  WebFetch: 'readonly',
  TaskGet: 'readonly',
  TaskList: 'readonly',
  TaskOutput: 'readonly',
  ListMcpResources: 'readonly',
  ListMcpResourcesTool: 'readonly',
  ReadMcpResource: 'readonly',
  ReadMcpResourceTool: 'readonly',
  ReadMcpResourceDirTool: 'readonly',
  RefreshMcpTools: 'readonly',
  WaitForMcpServers: 'readonly',
  EnterPlanMode: 'readonly',
  Skill: 'readonly',
  AskUserQuestion: 'readonly',
  ToolSearch: 'readonly',
  CronList: 'readonly',
  LSP: 'readonly',
  ReportFindings: 'readonly',
  SendUserFile: 'readonly',
  Write: 'edit',
  Edit: 'edit',
  NotebookEdit: 'edit',
  TodoWrite: 'edit',
  Agent: 'edit',
  TaskCreate: 'edit',
  TaskUpdate: 'edit',
  TaskStop: 'edit',
  EnterWorktree: 'edit',
  ExitWorktree: 'edit',
  ExitPlanMode: 'edit',
  Artifact: 'edit',
  CronCreate: 'edit',
  CronDelete: 'edit',
  DesignSync: 'edit',
  PushNotification: 'edit',
  RemoteTrigger: 'edit',
  ScheduleWakeup: 'edit',
  SendMessage: 'edit',
  ShareOnboardingGuide: 'edit',
  Workflow: 'edit',
  Bash: 'bash',
  Monitor: 'bash',
  PowerShell: 'bash',
  REPL: 'bash',
} as const satisfies Record<string, ClaudeCodeNativeToolKind>;

/**
 * Approval kind of a native tool. A name missing from the table is treated
 * as `'bash'` so that a tool the CLI adds later needs approval until it is
 * classified here.
 */
export function claudeCodeNativeToolKind(
  nativeName: string,
): ClaudeCodeNativeToolKind {
  return Object.prototype.hasOwnProperty.call(
    CLAUDE_CODE_NATIVE_TOOL_KINDS,
    nativeName,
  )
    ? CLAUDE_CODE_NATIVE_TOOL_KINDS[
        nativeName as keyof typeof CLAUDE_CODE_NATIVE_TOOL_KINDS
      ]
    : 'bash';
}
