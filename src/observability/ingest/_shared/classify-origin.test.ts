import { describe, expect, it } from 'vitest';
import { classifyUserMessageOrigin } from './classify-origin.js';

// The shapes below are taken from the real 199-session ingested corpus
// (codex + claude-code both emit injected/protocol content via role=user).

describe('classifyUserMessageOrigin', () => {
  it('tags genuine human prompts as human', () => {
    for (const t of [
      'fix the JWT bug in src/auth.ts',
      'yes please',
      'Review all PLAN.md files in .planning/phases/',
      '"The linter failed. Look at the lint output"',
      'no, revert that and keep it simple',
      'why is `parseToken` returning undefined?',
    ]) {
      expect(classifyUserMessageOrigin(t), t).toBe('human');
    }
  });

  it('tags harness-injected context as injected', () => {
    for (const t of [
      '<environment_context><cwd>N:/Aladeen</cwd></environment_context>',
      '<system-reminder>budget note</system-reminder>',
      '<local-command-caveat>Caveat: the messages below were generated…</local-command-caveat>',
      '<command-name>/commit</command-name>',
      '<command-message>committing…</command-message>',
      '<task>review this 1. a 2. b 3. c</task>',
      '<skill>graphify</skill>',
      '<image name=[Image #1]>',
      '</image>',
      '<user_action>',
      '<turn_aborted>The user aborted the turn</turn_aborted>',
      '# AGENTS.md instructions for N:\\NomadCrew',
      '# CLAUDE.md',
      '# In app browser:',
      'Base directory for this skill: /x/y',
      'The user interrupted the previous response',
      'lead-in text then <INSTRUCTIONS>do X</INSTRUCTIONS>',
    ]) {
      expect(classifyUserMessageOrigin(t), t).toBe('injected');
    }
  });

  it('tags inter-agent / tool protocol traffic as protocol', () => {
    for (const t of [
      '<teammate-message teammate_id="team-lead" summary="…">hi</teammate-message>',
      '<subagent_notification>child finished</subagent_notification>',
      '<task-notification>queued</task-notification>',
      '<tool_use_error>bad args</tool_use_error>',
      '{"agent_path":"019e33…","payload":{}}',
      '{"agent_id":"019ce4ee","type":"dispatch"}',
      '{"type":"request","role":"user"}',
    ]) {
      expect(classifyUserMessageOrigin(t), t).toBe('protocol');
    }
  });

  it('buckets an empty turn with machine noise (never human)', () => {
    expect(classifyUserMessageOrigin('')).toBe('injected');
    expect(classifyUserMessageOrigin('   \n  ')).toBe('injected');
  });

  it('does not mis-tag a human pasting HTML or a markdown heading', () => {
    // Conservative matching: only EXACT known tags/headers count as injected.
    expect(classifyUserMessageOrigin('<div>my component</div> is not rendering')).toBe('human');
    expect(classifyUserMessageOrigin('# My Feature Plan\nImplement the thing')).toBe('human');
    expect(classifyUserMessageOrigin('the <Image> component from next/image breaks')).toBe('human');
  });

  it('does not mis-tag a human pasting non-protocol JSON', () => {
    // No machine key (type/role/agent_*/requestId/tool_use_id) up front.
    expect(classifyUserMessageOrigin('{"name":"foo","version":"1.0.0"}')).toBe('human');
  });

  it('classifies on leading-whitespace-trimmed text', () => {
    expect(classifyUserMessageOrigin('   <environment_context>x</environment_context>')).toBe('injected');
  });
});
