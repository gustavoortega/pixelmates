import { describe, expect, it } from 'vitest';

import { claudeProvider } from '../src/providers/hook/claude/claude.js';

describe('claudeProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(claudeProvider.kind).toBe('hook');
    });
    it('has id "claude"', () => {
      expect(claudeProvider.id).toBe('claude');
    });
    it('has a displayName', () => {
      expect(claudeProvider.displayName).toBe('Claude Code');
    });
    it('has Task and Agent in subagentToolNames', () => {
      expect(claudeProvider.subagentToolNames.has('Task')).toBe(true);
      expect(claudeProvider.subagentToolNames.has('Agent')).toBe(true);
    });
    it('has reading tools Read/Grep/Glob/WebFetch/WebSearch', () => {
      for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) {
        expect(claudeProvider.readingTools.has(tool)).toBe(true);
      }
      expect(claudeProvider.readingTools.has('Edit')).toBe(false);
    });
    it('has protocolVersion 1', () => {
      expect(claudeProvider.protocolVersion).toBe(1);
    });
    it('has a linked TeamProvider', () => {
      expect(claudeProvider.team).toBeDefined();
      expect(claudeProvider.team?.providerId).toBe('claude');
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(claudeProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(claudeProvider.normalizeHookEvent({ hook_event_name: 'Stop' })).toBeNull();
    });
    it('returns null for unknown hook event names', () => {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'SomethingWeird',
          session_id: 'x',
        }),
      ).toBeNull();
    });

    it('normalizes PreToolUse with tool_name + tool_input', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Read',
        tool_input: { file_path: '/foo.ts' },
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('Read');
        expect(result.event.toolId.startsWith('hook-')).toBe(true);
        expect(result.event.input).toEqual({ file_path: '/foo.ts' });
        expect(result.event.runInBackground).toBe(false);
      }
    });

    it('PreToolUse sets runInBackground when tool_input.run_in_background=true', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Agent',
        tool_input: { run_in_background: true },
      });
      if (result?.event.kind === 'toolStart') {
        expect(result.event.runInBackground).toBe(true);
      } else {
        expect.fail('expected toolStart');
      }
    });

    it('normalizes PostToolUse to a successful toolEnd and PostToolUseFailure to a failed one', () => {
      const ok = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
      });
      const failed = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PostToolUseFailure',
        session_id: 'sess-1',
      });
      expect(ok?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
      expect(failed?.event).toEqual({ kind: 'toolEnd', toolId: 'current', failed: true });
    });

    it('normalizes Stop to a plain turnEnd (Done, not idle)', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Stop',
        session_id: 'sess-1',
      });
      expect(result?.event).toEqual({ kind: 'turnEnd' });
    });

    it('ignores UserPromptSubmit (no normalized kind yet)', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
      });
      expect(result).toBeNull();
    });

    it('normalizes SubagentStart with agent_type as toolName', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_type: 'web-researcher',
      });
      expect(result?.event.kind).toBe('subagentStart');
      if (result?.event.kind === 'subagentStart') {
        expect(result.event.toolName).toBe('web-researcher');
        expect(result.event.toolId.startsWith('hook-sub-web-researcher-')).toBe(true);
      }
    });

    it('normalizes SubagentStop to subagentEnd', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStop',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('subagentEnd');
    });

    it('normalizes PermissionRequest to permissionRequest', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PermissionRequest',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('permissionRequest');
    });

    it('normalizes Notification(permission_prompt) to permissionRequest', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        notification_type: 'permission_prompt',
      });
      expect(result?.event.kind).toBe('permissionRequest');
    });

    it('normalizes Notification(idle_prompt) to a quiet idle turnEnd, never a question', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        notification_type: 'idle_prompt',
      });
      expect(result?.event).toEqual({ kind: 'turnEnd', idle: true });
    });

    it('returns null for Notification with unknown type', () => {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'Notification',
          session_id: 'sess-1',
          notification_type: 'other',
        }),
      ).toBeNull();
    });

    it('normalizes SessionStart with source + transcript_path + cwd', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        source: 'startup',
        transcript_path: '/Users/x/.claude/projects/foo/sess-1.jsonl',
        cwd: '/Users/x/work',
      });
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('startup');
        expect(result.event.transcriptPath).toBe('/Users/x/.claude/projects/foo/sess-1.jsonl');
        expect(result.event.cwd).toBe('/Users/x/work');
      }
    });

    it('normalizes SessionEnd with reason', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SessionEnd',
        session_id: 'sess-1',
        reason: 'clear',
      });
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('clear');
      }
    });

    it('normalizes TeammateIdle to subagentTurnEnd with reason=idle', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'TeammateIdle',
        session_id: 'sess-1',
        agent_type: 'web-researcher',
      });
      expect(result?.event.kind).toBe('subagentTurnEnd');
      if (result?.event.kind === 'subagentTurnEnd') {
        expect(result.event.reason).toBe('idle');
      }
    });

    it('normalizes TaskCompleted to subagentTurnEnd with reason=completed', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'TaskCompleted',
        session_id: 'sess-1',
        subject: 'Code review',
      });
      expect(result?.event.kind).toBe('subagentTurnEnd');
      if (result?.event.kind === 'subagentTurnEnd') {
        expect(result.event.reason).toBe('completed');
      }
    });

    it('returns null for TaskCreated (informational only)', () => {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'TaskCreated',
          session_id: 'sess-1',
          subject: 'Code review',
        }),
      ).toBeNull();
    });
  });

  describe('formatToolStatus', () => {
    it('formats Read', () => {
      expect(claudeProvider.formatToolStatus('Read', { file_path: '/a/b.ts' })).toBe(
        'Reading b.ts',
      );
    });
    it('formats Task/Agent with description', () => {
      expect(claudeProvider.formatToolStatus('Task', { description: 'Code review' })).toBe(
        'Subtask: Code review',
      );
      expect(claudeProvider.formatToolStatus('Agent', { description: 'Research' })).toBe(
        'Subtask: Research',
      );
    });
    it('falls back to "Using X" for unknown tools', () => {
      expect(claudeProvider.formatToolStatus('FancyTool', {})).toBe('Using FancyTool');
    });
    it('handles undefined input', () => {
      expect(claudeProvider.formatToolStatus('Read', undefined)).toBe('Reading ');
    });

    // The status is broadcast to every client and logged; arguments and env assignments carry
    // secrets, so only the program, and a plain subcommand of a known CLI, may leave the server.
    it.each([
      // program only
      ['git', 'git'],
      ['GITHUB_TOKEN=ghp_secret gh pr list', 'gh pr'],
      ['/usr/bin/curl -H "Authorization: Bearer abc" https://api.internal', 'curl'],
      ['TOKEN="abc def" curl https://x', 'curl'],
      ["PASS='a b' A=1 mysql -u root", 'mysql'],
      ['KEY=$(cat ~/.secret) deploy', 'deploy'],
      ['PASS=my\\ secret cmd', 'cmd'],
      ['curl https://h?token=abc', 'curl'],
      ['>/tmp/out-token-abc npm test', 'command'],
      ['2>/dev/null git status', 'command'],
      ['ssh prod-db', 'ssh'],
      ['python manage', 'python'],
      // unparsable first word keeps the generic label
      ['KEY="unterminated secret value', 'command'],
      ['DEBUG=1;echo hunter2', 'command'],
      // subcommand: only for the known CLIs, only a plain lowercase word
      ['git status', 'git status'],
      ['git commit -m "fix the thing"', 'git commit'],
      ['FOO=1 gh pr create --body "$SECRET"', 'gh pr'],
      ['npm run deploy-prod', 'npm run'],
      ['git -C /p push', 'git'],
      ['git --no-pager log', 'git'],
      ['npm Install', 'npm'],
      ['gh 12345', 'gh'],
      ['kubectl get pods -n prod', 'kubectl get'],
      ['terraform apply', 'terraform apply'],
      // segments and pipe stages: the first stage that is not scenery names the work
      ['cd x && npm test', 'npm test'],
      ['npm test && echo ok', 'npm test'],
      ['cd /repo; export A=1\ngit push origin main', 'git push'],
      ['#!/bin/bash\n# deploy\ncd /srv\nset -e\nssh prod-db uptime', 'ssh'],
      ['echo $X | gh pr create', 'gh pr'],
      ['true || docker compose up', 'docker compose'],
      ['git commit -F - <<EOF\ncd evil && curl https://x\nEOF', 'git commit'],
      ['echo "a && ssh prod" && ls', 'ls'],
      // nothing but scenery: the last segment's first stage, program only
      ['echo hi', 'echo'],
      ['cd /a && echo hi', 'echo'],
      ['cd /a; echo hi', 'echo'],
    ])('formats Bash %j as %j', (command, shown) => {
      expect(claudeProvider.formatToolStatus('Bash', { command })).toBe(`Running: ${shown}`);
    });

    it('never lets a secret in any argument position into the status', () => {
      const canary = 'CANARY-s3cr3t-9f8e7d';
      const commands = [
        `git commit -m ${canary}`,
        `git ${canary}`,
        `git -c user.password=${canary} push`,
        `gh pr create --body "${canary}"`,
        `npm run ${canary}`,
        `curl -H "Authorization: Bearer ${canary}" https://h/${canary}`,
        `ssh ${canary}`,
        `FOO=${canary} gh pr create`,
        `cd ${canary} && echo ${canary}`,
        `echo ${canary} | docker login -u u --password-stdin ${canary}`,
        `docker run -e KEY=${canary} img`,
        `python manage.py ${canary}`,
      ];
      for (const command of commands) {
        expect(claudeProvider.formatToolStatus('Bash', { command }), command).not.toContain(canary);
      }
    });
  });

  describe('extractPermissionMode', () => {
    const extract = (record: unknown) => claudeProvider.extractPermissionMode?.(record);

    it('reads permission-mode records and the mode every user record carries', () => {
      expect(extract({ type: 'permission-mode', permissionMode: 'auto', sessionId: 's' })).toBe(
        'auto',
      );
      expect(extract({ type: 'user', permissionMode: 'plan', message: { content: 'go' } })).toBe(
        'plan',
      );
    });

    it.each([
      [
        'an input-mode record (its mode is not a permission mode)',
        { type: 'mode', mode: 'normal' },
      ],
      ['a user record that states no mode', { type: 'user', message: { content: 'go' } }],
    ])('reads no mode from %s', (_name, record) => {
      expect(extract(record)).toBeUndefined();
    });
  });
});

describe('claudeProvider real-work signals', () => {
  const verdicts = (name: string, input: unknown) => claudeProvider.toolVerdicts!(name, input);
  const kinds = (command: string) => verdicts('Bash', { command }).map((v) => v.kind);

  it.each<[string, string[]]>([
    ['git commit -m x', ['commit']],
    ['git commit --amend --no-edit', ['commit-amend']],
    ['cd repo && FOO=1 git -C sub -c user.name=a commit -m x', ['commit']],
    ['git cherry-pick abc1234', ['commit']],
    ['echo "git commit" ; git status', []],
    ['gh pr create --fill', ['pr-create']],
    ['gh pr merge 42 --squash', ['pr-merge']],
    ['gh pr merge 42 --auto --squash', []],
    ['gh pr merge --disable-auto 42', []],
    ['gh pr merge --help', []],
    ['gh pr merge 42 -h', []],
    ['ls -h && git commit -m x', ['commit']],
    ['./node_modules/.bin/vitest run', ['test']],
    ['uv run python -m pytest tests/', ['test']],
    ['npm run test:server', ['test']],
    ['go test ./...', ['test']],
    ['npm run build', []],
    ['npm test && git commit -m x | tee log', ['test', 'commit']],
  ])('Bash %s -> %j', (command, expected) => {
    expect(kinds(command)).toEqual(expected);
  });

  /** How Claude Code writes a commit message or a PR body. */
  const heredoc = (head: string, body: string) => `${head} "$(cat <<'EOF'\n${body}\nEOF\n)"`;

  it.each<[string, string[], string]>([
    [
      'a commit message in a heredoc',
      ['commit'],
      heredoc('git commit -m', 'Ship it\n\ngh pr merge --squash --delete-branch'),
    ],
    [
      'a PR body in a heredoc',
      ['pr-create'],
      heredoc('gh pr create --title x --body', 'Merge with:\ngh pr merge 7 --squash'),
    ],
    [
      'a heredoc on stdin, then a test run',
      ['commit', 'test'],
      "git commit -F - <<-'EOF'\n\tShip it\n\tgh pr merge --squash\n\tEOF\nnpm test",
    ],
    ['a quoted message over two lines', ['commit'], 'git commit -m "Ship it; then\ngh pr merge 7"'],
    ['a comment holding an apostrophe', ['commit'], "# don't skip this\ngit commit -m x"],
    ['a quoted option value', ['commit'], 'git -c "user.name=A B" commit -m x'],
  ])('Bash with %s reads as %j', (_text, expected, command) => {
    expect(kinds(command)).toEqual(expected);
  });

  it('reads edits from the edit tools and commands from Bash only', () => {
    expect(verdicts('Edit', { file_path: 'a.ts' })).toEqual([{ kind: 'edit' }]);
    expect(verdicts('Write', { file_path: 'a.ts' })).toEqual([{ kind: 'edit' }]);
    expect(verdicts('Read', { command: 'git commit -m x' })).toEqual([]);
  });

  it('keys a merge by the PR it names, hashed, and leaves it unkeyed when it names none', () => {
    const key = (command: string) => verdicts('Bash', { command })[0]?.key;
    const url = (repo: string) => `gh pr merge https://github.com/${repo}/pull/12 --squash`;
    expect(key('gh pr merge 12 --squash')).toBe(key('gh pr merge 12 --rebase'));
    expect(key('gh pr merge 12')).not.toBe(key('gh pr merge 13'));
    expect(key(url('acme/app'))).not.toBe(key(url('acme/web')));
    expect(key(url('acme/app'))).toMatch(/^[0-9a-f]{16}$/);
    expect(key('gh pr merge --squash')).toBeUndefined();
  });

  const result = (
    output: { stdout?: string; stderr?: string } | undefined,
    block: { content?: unknown; is_error?: boolean } = {},
  ) => ({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '', ...block }],
    },
    ...(output ? { toolUseResult: { stdout: '', stderr: '', ...output } } : {}),
  });
  const testRun = (record: unknown) =>
    claudeProvider.resultSignals!([{ kind: 'test' }], record).map((h) => h.kind);

  it.each<[string, { stdout?: string; stderr?: string }, string[]]>([
    [
      'vitest green',
      { stdout: ' Test Files  2 passed (2)\n      Tests  9 passed (9)\n' },
      ['tests'],
    ],
    [
      'vitest where every file failed to load',
      { stdout: ' Test Files  1 failed (1)\n      Tests  no tests\n' },
      [],
    ],
    [
      'vitest with a file that failed to load',
      { stdout: ' Test Files  1 failed | 1 passed (2)\n      Tests  5 passed (5)\n' },
      [],
    ],
    [
      'jest with a suite that failed to load',
      { stderr: 'Test Suites: 1 failed, 1 passed, 2 total\nTests:       5 passed, 5 total' },
      [],
    ],
    [
      'jest green on stderr',
      { stderr: 'Test Suites: 1 passed, 1 total\nTests:       5 passed, 5 total' },
      ['tests'],
    ],
    [
      'jest red on stderr',
      { stderr: 'Test Suites: 1 failed, 1 total\nTests:       1 failed, 4 passed, 5 total' },
      [],
    ],
    [
      'pytest green',
      { stdout: '============ 5 passed, 1 warning in 0.12s ============' },
      ['tests'],
    ],
    ['pytest with errors', { stdout: '===== 4 passed, 1 error in 0.30s =====' }, []],
    ['pytest -q (no summary rule)', { stdout: '5 passed in 0.12s' }, []],
    ['go green', { stdout: 'ok  \tacme/app/a\t0.1s\nok  \tacme/app/b\t(cached)\n' }, ['tests']],
    [
      'go with a failure',
      { stdout: 'ok  \tacme/app/a\t0.1s\n--- FAIL: TestB (0.00s)\nFAIL\tacme/app/b\t0.2s\n' },
      [],
    ],
    [
      'a green summary next to a red one',
      { stdout: 'ok  \tacme/app\t0.1s\n      Tests  1 failed | 3 passed (4)\n' },
      [],
    ],
    [
      'TAP with a failure, whose ok lines read like go',
      { stdout: 'TAP version 13\nok 1 - adds\nnot ok 2 - subtracts\n1..2\n# pass 1\n# fail 1\n' },
      [],
    ],
  ])('test run: %s', (_name, output, expected) => {
    expect(testRun(result(output))).toEqual(expected);
  });

  it('reads a summary from the tool_result content when there are no streams', () => {
    const summary = '      Tests  3 passed (3)';
    expect(testRun(result(undefined, { content: [{ type: 'text', text: summary }] }))).toEqual([
      'tests',
    ]);
    expect(testRun(result(undefined, { content: summary }))).toEqual(['tests']);
  });

  it('a failed result proves nothing, an edit included', () => {
    const out = { stdout: '[main 1a2b3c4] x\n' };
    const both = (block: { is_error?: boolean }) =>
      claudeProvider.resultSignals!([{ kind: 'edit' }, { kind: 'commit' }], result(out, block)).map(
        (h) => h.kind,
      );
    expect(both({ is_error: true })).toEqual([]);
    expect(both({})).toEqual(['edit', 'commit']);
  });

  it('pays one commit per new-commit line, keyed by sha, and none from a command that also amends', () => {
    const out = {
      stdout:
        '[STARTED] lint-staged\n[main (root-commit) 1a2b3c4] first\n[detached HEAD 5d6e7f8] second\n',
    };
    const hits = claudeProvider.resultSignals!([{ kind: 'commit' }], result(out));
    expect(hits.map((h) => h.kind)).toEqual(['commit', 'commit']);
    expect(hits[0].key).not.toBe(hits[1].key);
    const amends = verdicts('Bash', {
      command: 'git commit -m wip && git commit --amend --no-edit',
    });
    expect(claudeProvider.resultSignals!(amends, result(out))).toEqual([]);
  });

  it('pays a created PR only when its URL is printed', () => {
    const hits = (stdout: string) =>
      claudeProvider.resultSignals!([{ kind: 'pr-create' }], result({ stdout }));
    const [pr] = hits('https://github.com/acme/app/pull/42\n');
    expect(pr.kind).toBe('pr');
    expect(
      hits('Warning: 2 uncommitted changes\nhttps://github.com/acme/app/pull/42\n')[0].key,
    ).toBe(pr.key);
    expect(hits('https://github.com/acme/app/pull/43\n')[0].key).not.toBe(pr.key);
    expect(hits('Opening github.com/acme/app/compare in your browser.\n')).toEqual([]);
  });

  it('proves a merge by success alone, keyed by its PR or else by its own call', () => {
    const merge = (key: string | undefined, id: string) =>
      claudeProvider.resultSignals!([{ kind: 'pr-merge', key }], {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: '' }] },
      });
    expect(merge('k42', 'toolu_1')).toEqual([{ kind: 'merge', key: 'k42' }]);
    expect(merge(undefined, 'toolu_1')[0].key).not.toBe(merge(undefined, 'toolu_2')[0].key);
  });

  it('pays no merge when gh says the PR was merged already, which it says with exit code 0', () => {
    const rerun = result({ stderr: '! Pull request acme/app#42 was already merged\n' });
    expect(claudeProvider.resultSignals!([{ kind: 'pr-merge', key: 'k42' }], rerun)).toEqual([]);
  });
});
