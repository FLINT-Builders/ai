import { describe, expect, it } from 'vitest';
import { toClaudeSkillsOption } from './claude-skills-option';

describe('toClaudeSkillsOption', () => {
  it('omits the SDK skills option when no harness skills are configured', () => {
    expect(toClaudeSkillsOption(undefined)).toBeUndefined();
    expect(toClaudeSkillsOption([])).toBeUndefined();
  });

  it('passes configured skill names through as the SDK allowlist', () => {
    expect(toClaudeSkillsOption(['weather-forecast'])).toEqual([
      'weather-forecast',
    ]);
    expect(toClaudeSkillsOption(['weather-forecast', 'weather-codes'])).toEqual(
      ['weather-forecast', 'weather-codes'],
    );
  });
});
