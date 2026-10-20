import { PATH_IGNORE_KEYS, type TripwireRule } from './tripwires.js';

/**
 * Built-in detection rules. Tuned offline against a verdict table (hits and
 * near misses) and adversarial repeats; see docs/tripwires.md for the table.
 *
 * Two regex idioms are load-bearing, keep them in any new rule:
 * - "keyword, then later on the same line X" starts with the atomic
 *   first-occurrence prefix `^(?=(?<k>[^\n]*?\bKEYWORD\b))\k<k>[^\n;&|]*X` and flag `m`.
 *   The plain `\bKEYWORD\b[^\n]*X` form is quadratic on repeated keywords.
 *   `[^\n;&|]` stops at the next chained command; pipe-to-shell keeps `[^\n]*`
 *   because it needs the pipe.
 * - Option skipping is bounded (`{0,6}`); unbounded repeats backtrack for seconds.
 */
export const DEFAULT_TRIPWIRE_RULES: readonly TripwireRule[] = [
  {
    id: 'cloud-credentials',
    name: 'Cloud credentials access',
    severity: 'high',
    tool: /.*/,
    input: new RegExp(
      String.raw`(^|[/\s"'=])\.aws(/(credentials|config\b|sso/cache/|cli/cache/)|/?($|[\s"']))|\.config/gcloud/|\.azure/|\.kube/config\b|\baws\s+configure\s+(export-credentials|get\s+\S*secret)|\baws\s+sts\s+get-(session|federation)-token\b`,
      'i',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'ssh-private-key',
    name: 'SSH private key access',
    severity: 'high',
    tool: /.*/,
    input: new RegExp(String.raw`\.ssh/id_[A-Za-z0-9_]+(?!\.pub)\b`, 'i'),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'sensor-tamper',
    name: 'Agent sensor or config tampering',
    severity: 'high',
    tool: /.*/,
    input: new RegExp(
      String.raw`\.(pixelmates|pixel-agents)/|\.claude/(settings(\.local)?\.json|hooks/|\.credentials)|\.claude\.json\b`,
      'i',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'dotenv',
    name: 'Dotenv file access',
    severity: 'medium',
    tool: /.*/,
    input: new RegExp(
      String.raw`(^|[\s/"'=])\.env(?!\.(example|sample|template)\b)(\.[\w-]+)?($|[\s"'])`,
      'i',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'secret-literal',
    name: 'Secret literal in tool input',
    severity: 'high',
    tool: /.*/,
    // Slack and Anthropic need a key body: docs, regexes and test names that only
    // name the pattern carry the bare prefix.
    input: new RegExp(
      String.raw`\b(AKIA|ASIA)(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{36}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\bsk-ant-[A-Za-z0-9_-]{20,}`,
      '',
    ),
    ignoreKeys: [],
  },
  {
    id: 'pipe-to-shell',
    name: 'Download piped into a shell',
    severity: 'high',
    tool: /^Bash$/,
    input: new RegExp(
      String.raw`^(?=(?<k>[^\n]*?\b(?:curl|wget)\b))\k<k>[^\n]*\|\s*(sudo(\s+-\S+)*\s+)?((ba|z|da|k|fi)?sh|python[\d.]*(?!\s+-m\s)|node|perl|ruby)\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)\b`,
      'm',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'aws-mutation',
    name: 'AWS write operation',
    severity: 'high',
    tool: /^Bash$/,
    input: new RegExp(
      String.raw`\baws\s+(--?\S+\s+\S+\s+){0,3}(s3\s+(rm|rb|mv)\b|s3\s+(cp|sync)\s+(-\S+\s+){0,3}\S+\s+(-\S+\s+){0,3}s3://|[a-z0-9-]+\s+(create|delete|put|update(?!-kubeconfig)|attach|detach|modify|terminate|remove|run|start(?!-(query|live-tail))|stop(?!-query)|reboot|revoke|authorize|add|associate|disassociate|enable|disable|set|tag|untag|register|deregister|schedule|reset|rotate|replace|invoke|send|import)-)`,
      '',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'file-upload',
    name: 'File upload with curl',
    severity: 'medium',
    tool: /^Bash$/,
    input: new RegExp(
      String.raw`^(?=(?<k>[^\n]*?\bcurl\b))\k<k>[^\n;&|]*\s((-d|--data(-binary|-raw|-urlencode)?|-F|--form)\s*["']?[\w.-]*=?@|(-T|--upload-file)\s+\S)`,
      'm',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'git-force-push',
    name: 'Git force push',
    severity: 'medium',
    tool: /^Bash$/,
    input: new RegExp(
      String.raw`^(?=(?<k>[^\n]*?\bgit\s+push\b))\k<k>[^\n;&|]*(\s--force\b(?!-with-lease|-if-includes)|\s-f[a-zA-Z]*\b|\s\+[\w/-]+)`,
      'm',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'recursive-delete-home',
    name: 'Recursive delete of home',
    severity: 'high',
    tool: /^Bash$/,
    input: new RegExp(
      String.raw`\brm\s+(-[a-zA-Z]+\s+|--\S+\s+){0,6}?(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+(-[a-zA-Z]+\s+|--\S+\s+){0,6}("?\$\{?HOME\}?"?|~|/|/Users/\w+|/home/\w+)(/[\w.-]+)?/?\*?(\s|$)`,
      '',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'iac-apply',
    name: 'Infrastructure apply or destroy',
    severity: 'high',
    tool: /^Bash$/,
    input: new RegExp(
      String.raw`\b(terraform|terragrunt|tofu)\s+(-\S+\s+){0,3}(run-all\s+)?(apply|destroy|import|state\s+(rm|mv))\b`,
      '',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'k8s-write',
    name: 'Kubernetes write operation',
    severity: 'medium',
    tool: /^Bash$/,
    input: new RegExp(
      String.raw`\bkubectl\s+(-\S+\s+([^-\s]\S*\s+)?){0,6}(delete|apply|patch|exec|cp|scale|drain|create|edit|replace|run|set|label|annotate|cordon|port-forward|rollout\s+(restart|undo|pause|resume))\b|\bhelm\s+(install|upgrade|uninstall|rollback)\b`,
      '',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'gh-write',
    name: 'GitHub write operation',
    severity: 'medium',
    tool: /^Bash$/,
    input: new RegExp(
      String.raw`\bgh\s+(pr\s+(merge|close|create|comment|edit)|issue\s+(create|close|comment|edit)|release\s+(create|delete)|repo\s+(create|edit|archive|delete)|secret\s+(set|delete)|workflow\s+run|run\s+cancel)\b|^(?=(?<k>[^\n]*?\bgh\s+api\b))\k<k>[^\n;&|]*\s(-X\s*(POST|PUT|PATCH|DELETE)|--method[\s=]+(POST|PUT|PATCH|DELETE)|-[fF]\s|--field\b|--raw-field\b|--input\b)`,
      'm',
    ),
    ignoreKeys: PATH_IGNORE_KEYS,
  },
  {
    id: 'mcp-outbound',
    name: 'Outbound MCP tool call',
    severity: 'medium',
    tool: /^mcp__.+?__(?!(?:\w*_)?(?:list|get|search|read|describe)_)\w*(send|forward|reply|share|publish|update_sharing|add_member|delete|trash|remove)/,
  },
];
