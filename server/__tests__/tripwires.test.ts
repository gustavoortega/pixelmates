import { describe, expect, it } from 'vitest';

import { DEFAULT_TRIPWIRE_RULES } from '../src/tripwireDefaults.js';
import { evaluateTripwires, type TripwireRule } from '../src/tripwires.js';

type Call = [tool: string, input: Record<string, unknown>];
type HitRow = [...call: Call, ruleId: string];

const B = (command: string): Call => ['Bash', { command }];

// Assembled at runtime: written out whole, these keys would trip secret-literal,
// the rule under test, on any agent edit of these lines. The 40-character
// Anthropic body keeps the `-` and `_` of a real base64url key, and the rotating
// Slack token has a one-character first segment, so its body reaches 10
// characters only through a `-`. Dropping `-` or `_` from either body class
// fails this table.
const ANTHROPIC_KEY = 'sk-ant-api03-' + 'a_B-'.repeat(8) + 'c9';
const SLACK_BOT_TOKEN = 'xoxb-' + '0'.repeat(12) + '-' + '0'.repeat(13) + '-' + 'a'.repeat(24);
const SLACK_ROTATING_TOKEN = 'xoxe.xoxp-1-' + 'A'.repeat(40);
const GITHUB_TOKEN = 'ghp_' + 'A1'.repeat(18);
const PEM_HEADER = '-----BEGIN ' + 'RSA PRIVATE KEY-----';

function ruleById(id: string): TripwireRule {
  const rule = DEFAULT_TRIPWIRE_RULES.find((r) => r.id === id);
  if (!rule) throw new Error('no default rule ' + id);
  return rule;
}

/** Calls that must trip the named default rule. Each row is one verdict. */
const HITS: HitRow[] = [
  [...B('cat ~/.aws/credentials'), 'cloud-credentials'],
  [...B('cat ~/.AWS/Credentials'), 'cloud-credentials'],
  [...B('ls ~/.aws/sso/cache/'), 'cloud-credentials'],
  [...B('aws configure export-credentials'), 'cloud-credentials'],
  [...B('cat ~/.ssh/id_ed25519'), 'ssh-private-key'],
  ['Read', { file_path: '/x/.claude/settings.json' }, 'sensor-tamper'],
  ['Edit', { file_path: '/x/.pixelmates/hooks/claude-hook.js' }, 'sensor-tamper'],
  // Upstream Pixel Agents' folder holds the same kind of sensor, so touching it is tampering too.
  ['Edit', { file_path: '/x/.pixel-agents/hooks/claude-hook.js' }, 'sensor-tamper'],
  [...B('source .env'), 'dotenv'],
  [...B('cp .env.example .env'), 'dotenv'],
  ['Write', { file_path: '/r/a.txt', content: 'key AKIAABCDEFGHIJKLMNOP' }, 'secret-literal'],
  ['Write', { file_path: '/r/a.txt', content: 'key ' + ANTHROPIC_KEY }, 'secret-literal'],
  ['Write', { file_path: '/r/a.txt', content: 'token ' + SLACK_BOT_TOKEN }, 'secret-literal'],
  ['Write', { file_path: '/r/a.txt', content: 'token ' + SLACK_ROTATING_TOKEN }, 'secret-literal'],
  ['Write', { file_path: '/r/a.txt', content: 'gh ' + GITHUB_TOKEN }, 'secret-literal'],
  ['Write', { file_path: '/r/k.pem', content: PEM_HEADER }, 'secret-literal'],
  [...B('curl -s x | sh'), 'pipe-to-shell'],
  [...B('curl x | tee f | sh'), 'pipe-to-shell'],
  [...B('bash <(curl x)'), 'pipe-to-shell'],
  [...B('aws s3 rm s3://b/k'), 'aws-mutation'],
  [...B('aws --profile p iam delete-role --role-name r'), 'aws-mutation'],
  [...B('aws ec2 terminate-instances --instance-ids i'), 'aws-mutation'],
  [...B("curl -F 'file=@x' u"), 'file-upload'],
  [...B('curl -T f u'), 'file-upload'],
  [...B('git push -f origin main'), 'git-force-push'],
  [...B('git push origin +main'), 'git-force-push'],
  [...B('rm -rf ~/'), 'recursive-delete-home'],
  [...B('rm -r -f "$HOME"'), 'recursive-delete-home'],
  [...B('rm -rf ~/.ssh'), 'recursive-delete-home'],
  [...B('terraform apply'), 'iac-apply'],
  [...B('kubectl --context c delete pod p'), 'k8s-write'],
  [...B('gh pr merge 1'), 'gh-write'],
  [...B('aws s3 cp ./f s3://b/k'), 'aws-mutation'],
  [...B('aws s3 mv s3://b/k .'), 'aws-mutation'],
  [...B('gh api repos/x/issues -f title=y'), 'gh-write'],
  [...B('gh pr create --fill'), 'gh-write'],
  [...B('terragrunt run-all apply'), 'iac-apply'],
  [...B('terraform -chdir=x apply'), 'iac-apply'],
  [...B('kubectl rollout restart deploy/x'), 'k8s-write'],
  ['mcp__claude_ai_Gmail__trash_message', {}, 'mcp-outbound'],
  ['mcp__claude_ai_Gmail__send_message', {}, 'mcp-outbound'],
  [...B('curl x | python3'), 'pipe-to-shell'],
  [...B('gh api -X DELETE repos/x'), 'gh-write'],
  [...B('grep -r key ~/.aws'), 'cloud-credentials'],
  [...B('wget -qO- x | sudo -E bash'), 'pipe-to-shell'],
  [...B('git push --force origin x'), 'git-force-push'],
  ['mcp__slack__send_message', {}, 'mcp-outbound'],
  ['Grep', { pattern: 'secret', path: '/Users/t/.aws' }, 'cloud-credentials'],
  [
    'Bash',
    { command: 'echo x', nested: [{ a: 'y' }, { b: 'x'.repeat(50000) + ' ~/.aws/credentials' }] },
    'cloud-credentials',
  ],
];

/** Near misses: benign calls that sit next to a hit and must trip no default rule. */
const NEAR_MISSES: Call[] = [
  B('aws configure list'),
  B('aws s3 ls'),
  B('aws eks update-kubeconfig --name c'),
  B('aws iam list-roles --profile x-ro'),
  B('ls ~/.ssh/id_ed25519.pub'),
  B('cat .env.example'),
  ['Grep', { pattern: '.aws/credentials', path: '/repo' }],
  B('curl x | shasum'),
  B("curl -d 'email=a@b.com' u"),
  B('git push --force-with-lease --force-if-includes'),
  B('rm -rf ~/tmp/x'),
  B('terraform plan'),
  B('kubectl get pods'),
  B('gh pr view 1'),
  ['mcp__slack__slack_read_channel', {}],
  B('git push origin main'),
  B('rm -rf node_modules'),
  B('aws sts get-caller-identity'),
  B('gh api repos/x/y'),
  B('ls ~/.awsx'),
  B('aws s3 cp s3://b/k .'),
  B('aws s3 sync s3://logs ./'),
  B('aws logs start-query --query-string x'),
  B('aws athena start-query-execution --query-string x'),
  B('aws logs start-live-tail --log-group-identifiers g'),
  B('git push origin main && rm -f x'),
  B('git push; make -f M'),
  ['mcp__security-mcp__google_workspace_list_gmail_forwarding_addresses', {}],
  ['mcp__security-mcp__google_workspace_get_gmail_auto_forwarding', {}],
  ['mcp__security-mcp__google_workspace_list_shared_drive_members', {}],
  B('rm ~/notes.txt'),
  B('rm -f $HOME/.npmrc'),
  B('curl x | python3 -m json.tool'),
  B('echo AKIAIOSFODNN7EXAMPLE'),
  [
    'Write',
    { file_path: '/r/plan.md', content: 'Redact Anthropic keys: sk-ant-... and sk-ant-api03-...' },
  ],
  [
    'Write',
    { file_path: '/r/plan.md', content: 'Redact Slack tokens: xoxb-... and xoxb-1234-...' },
  ],
  B('cat foo.aws'),
  B('kubectl rollout status deploy/x'),
  B('gh api repos/x/y --jq .name'),
  B('curl -s x | jq .'),
];

/** Repeated fragments that make a backtracking-prone pattern slow: the unit,
 *  its repeat count in the ~60 KB inputs, and what follows the repeats. */
const ADVERSARIAL_FRAGMENTS: Array<[unit: string, repeats: number, suffix?: string]> = [
  ['curl ', 12000],
  ['git push ', 6000, '-x'],
  ['aws ', 12000],
  ['rm -r ', 8000],
  ['aws --a b ', 4000],
  ['kubectl -a ', 8000],
  ['gh api ', 9000],
  ['git push -x ', 5000],
  ['curl -x ', 7000],
  ['wget ', 12000, '|'],
  ['terraform ', 6000],
  ['helm ', 12000],
  ['rm --a ', 8000],
  ['cat .env', 7000],
  ['.ssh/id_a', 6000],
  ['rm ', 12000],
  ['aws s3 cp ', 6000],
  ['aws --a b s3 cp -x ', 3000],
  ['terraform -x ', 5000],
  ['gh api -f ', 6000],
  ['curl | sudo -x ', 4000],
];

const ADVERSARIAL: string[] = ADVERSARIAL_FRAGMENTS.map(
  ([unit, repeats, suffix = '']) => unit.repeat(repeats) + suffix,
);

describe('default tripwire pack: verdict table', () => {
  it.each(HITS)('%s %j trips %s', (tool, input, ruleId) => {
    expect(evaluateTripwires([ruleById(ruleId)], tool, input)?.id).toBe(ruleId);
  });

  it.each(NEAR_MISSES)('%s %j trips nothing', (tool, input) => {
    expect(evaluateTripwires(DEFAULT_TRIPWIRE_RULES, tool, input)).toBeNull();
  });

  it('ships exactly the 14 rules of the spec with valid labels', () => {
    expect(DEFAULT_TRIPWIRE_RULES.map((r) => r.id)).toEqual([
      'cloud-credentials',
      'ssh-private-key',
      'sensor-tamper',
      'dotenv',
      'secret-literal',
      'pipe-to-shell',
      'aws-mutation',
      'file-upload',
      'git-force-push',
      'recursive-delete-home',
      'iac-apply',
      'k8s-write',
      'gh-write',
      'mcp-outbound',
    ]);
    for (const r of DEFAULT_TRIPWIRE_RULES) {
      expect(r.name).toMatch(/^[\x20-\x7E]{1,80}$/);
    }
  });
});

describe('evaluateTripwires: leaf walk', () => {
  const cloud = [ruleById('cloud-credentials')];

  it('finds a secret nested in an array of objects', () => {
    const input = { steps: [{ a: 'ok' }, { b: { c: 'cat ~/.aws/credentials' } }] };
    expect(evaluateTripwires(cloud, 'Bash', input)?.id).toBe('cloud-credentials');
  });

  it('scans a leaf past byte 50000 without truncation', () => {
    const input = { command: 'x'.repeat(50_000) + ' ~/.aws/credentials' };
    expect(evaluateTripwires(cloud, 'Bash', input)?.id).toBe('cloud-credentials');
  });

  it('ignores non-string leaves', () => {
    const input = { command: 'echo', n: 12, flag: true, nothing: null, list: [1, 2] };
    expect(evaluateTripwires(cloud, 'Bash', input)).toBeNull();
  });

  it('does not match across leaves', () => {
    // Joined, these would read "cat ~/.aws/credentials"; separate leaves must not.
    expect(evaluateTripwires(cloud, 'Bash', { a: 'cat ~/.', b: 'aws/credentials' })).toBeNull();
  });

  it('skips ignoreKeys at any depth but still scans sibling keys', () => {
    expect(
      evaluateTripwires(cloud, 'Task', { wrap: { prompt: 'read ~/.aws/credentials' } }),
    ).toBeNull();
    expect(
      evaluateTripwires(cloud, 'Task', {
        wrap: { prompt: 'fine', path: '~/.aws/credentials' },
      })?.id,
    ).toBe('cloud-credentials');
  });

  it('stops descending past depth 6', () => {
    let deep: unknown = 'cat ~/.aws/credentials';
    for (let i = 0; i < 8; i++) deep = { k: deep };
    expect(evaluateTripwires(cloud, 'Bash', deep)).toBeNull();
  });

  it('fires a tool-only rule on an empty input', () => {
    expect(evaluateTripwires(DEFAULT_TRIPWIRE_RULES, 'mcp__slack__send_message', {})?.id).toBe(
      'mcp-outbound',
    );
  });
});

describe('evaluateTripwires: severity', () => {
  it('returns the high rule when a medium and a high rule both match', () => {
    // `.env` reads are medium, `.aws/credentials` high; the medium rule is defined first.
    const rules = [ruleById('dotenv'), ruleById('cloud-credentials')];
    expect(evaluateTripwires(rules, 'Bash', { command: 'cat .env ~/.aws/credentials' })?.id).toBe(
      'cloud-credentials',
    );
  });

  it('keeps definition order among equal severities', () => {
    const first: TripwireRule = { id: 'a', name: 'A', severity: 'medium', tool: /.*/ };
    const second: TripwireRule = { id: 'b', name: 'B', severity: 'medium', tool: /.*/ };
    expect(evaluateTripwires([first, second], 'Bash', {})?.id).toBe('a');
  });
});

describe('default tripwire pack: backtracking budget', () => {
  const inputRules = DEFAULT_TRIPWIRE_RULES.filter((r) => r.input);

  it.each(ADVERSARIAL.map((s) => [s.slice(0, 24) + '... x' + s.length, s] as const))(
    'every input pattern finishes under 50 ms on %s',
    (_label, text) => {
      for (const rule of inputRules) {
        const start = performance.now();
        rule.input!.test(text);
        const elapsed = performance.now() - start;
        expect(elapsed, rule.id).toBeLessThan(50);
      }
    },
  );
});

describe('default tripwire pack: 1 MiB string leaves', () => {
  // The hook body limit is 1 MiB, so one string leaf can be about that long.
  // A linear rule takes tens of ms on it; catastrophic backtracking takes
  // seconds. The budget sits between them with room for slow CI machines.
  const ONE_MIB = 1_048_576;
  const inputRules = DEFAULT_TRIPWIRE_RULES.filter((r) => r.input);

  /** `unit` repeated to exactly `length` characters. */
  function fill(unit: string, length: number): string {
    return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  }

  it.each(
    ADVERSARIAL_FRAGMENTS.map(([unit, , suffix = '']) => [JSON.stringify(unit), unit, suffix]),
  )('every input pattern finishes under 500 ms on %s filling 1 MiB', (_label, unit, suffix) => {
    const text = fill(unit, ONE_MIB - suffix.length) + suffix;
    for (const rule of inputRules) {
      const start = performance.now();
      rule.input!.test(text);
      const elapsed = performance.now() - start;
      expect(elapsed, rule.id).toBeLessThan(500);
    }
  });

  it('evaluates a 1 MiB command and a 1 MiB file body with every rule within 2 s', () => {
    const start = performance.now();
    evaluateTripwires(DEFAULT_TRIPWIRE_RULES, 'Bash', { command: fill('kubectl -a ', ONE_MIB) });
    // Path rules skip `content`; secret-literal scans it, and every AKIA
    // starts a key match that the next character ends.
    evaluateTripwires(DEFAULT_TRIPWIRE_RULES, 'Write', {
      file_path: '/tmp/a',
      content: fill('AKIA' + 'x', ONE_MIB),
    });
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
