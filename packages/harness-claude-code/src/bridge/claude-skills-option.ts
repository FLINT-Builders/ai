export function toClaudeSkillsOption(
  skills: ReadonlyArray<string> | undefined,
): string[] | undefined {
  /*
   * The Claude Agent SDK treats `skills: string[]` as an allowlist. This must
   * stay the host-configured names: `'all'` would also enable every skill the
   * CLI discovers in the workspace, including skills committed under the
   * project's `.claude/skills`.
   */
  return skills && skills.length > 0 ? [...skills] : undefined;
}
