import { describe, expect, it } from 'vitest';
import { toClaudeSkillsOption } from './claude-skills-option';

describe('toClaudeSkillsOption', () => {
  it('omits the SDK skills option when no harness skills are configured', () => {
    expect(toClaudeSkillsOption(undefined)).toBeUndefined();
    expect(toClaudeSkillsOption([])).toBeUndefined();
  });

  it('enables only the configured harness skills', () => {
    expect(toClaudeSkillsOption(['weather-forecast'])).toEqual([
      'weather-forecast',
    ]);
  });
});
