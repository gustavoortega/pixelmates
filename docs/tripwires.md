# Tripwires

Tripwires check every tool call of every tracked agent against detection rules. A hit shows a flashing beacon over the agent, a `⚠ <rule name>` line in its overlay and a two-tone alarm (if sound is on). Click the line to acknowledge it.

Tripwires are alert-only. They never block a tool call: the Claude Code hook script does not read the server's reply. Agents running without hooks (heuristic mode) are not checked.

## Privacy

The tool input that matched never leaves the server. The browser receives the rule id, the rule name, the severity and a hit count. The server log line is `Tripwire <ruleId> agent <id>`.

## Counting

`count` is the number of hits since the last acknowledgement, across all rules. The rule shown is the highest severity seen since then (the latest among equals). The alarm sound plays on the first hit and on a severity escalation, not on a plain count bump. An acknowledgement clears the alarm only if no newer hit arrived meanwhile.

## Your own rules

Create `~/.pixelmates/tripwires.json`. Rules are read once at server start: restart to reload. A missing file means the default pack; malformed JSON means the default pack and one log line.

```json
{
  "enabled": true,
  "disable": ["mcp-outbound"],
  "rules": [
    {
      "id": "prod-db",
      "name": "Production database access",
      "severity": "high",
      "tool": "^Bash$",
      "input": "^(?=(?<k>[^\\n]*?\\bpsql\\b))\\k<k>[^\\n;&|]*prod",
      "flags": "im",
      "ignoreKeys": ["description"]
    }
  ]
}
```

- `enabled: false` turns every rule off.
- `disable` removes default rules by id.
- A rule with a default's id replaces that default.
- `id` matches `^[a-z0-9][a-z0-9-]{0,63}$`. `name` is 1 to 80 printable ASCII characters without `<` or `>`. `severity` is `high`, `medium` or `low`.
- `tool` is a regex tested against the tool name. `input` is optional: without it the rule fires on the tool name alone. With it, the rule fires when the regex matches any string value in the tool input, at any depth up to 6, one value at a time (matches never span two values).
- `flags` is any of `i`, `m` and applies to `input` only. `ignoreKeys` lists input keys whose values are not scanned.
- An invalid rule is skipped and logged by its position in the file, never by its content.

Write exclusions inside `input` as negative lookaheads next to the thing they exclude (`\.env(?!\.example)`), not as a separate rule, so a harmless token cannot hide a harmful one in the same call.

Two regex idioms keep patterns fast:

1. "Keyword, then later on the same line X": use the atomic first-occurrence prefix with flag `m`: `^(?=(?<k>[^\n]*?\bKEYWORD\b))\k<k>[^\n;&|]*X`. The plain `\bKEYWORD\b[^\n]*X` form is quadratic when the keyword repeats. `[^\n;&|]` stops at the next chained command.
2. Skipping options: bound the repeat (`(-\S+\s+){0,6}`), never `*`.

Warning: a user regex with catastrophic backtracking stalls the whole server, which runs on one event loop. A string value can be up to 1 MiB (the hook body limit), so test patterns against long repeated input before adding them.

## Default pack

| Id                      | Severity | Fires on                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud-credentials`     | high     | `~/.aws` credentials, config and SSO cache, gcloud, azure, kubeconfig, `aws configure export-credentials`, `aws sts get-session-token`                                                                                                                                                     |
| `ssh-private-key`       | high     | `~/.ssh/id_*` except `.pub`                                                                                                                                                                                                                                                                |
| `sensor-tamper`         | high     | `~/.pixelmates/`, `~/.claude` settings, hooks and credentials, `~/.claude.json`                                                                                                                                                                                                          |
| `secret-literal`        | high     | AWS access key ids, GitHub tokens, Slack tokens, PEM private key headers, `sk-ant-` keys, in any input including file contents. Slack and `sk-ant-` need a key body after the prefix (at least 10 and 20 characters), so a doc or regex that only names `xoxb-` or `sk-ant-` does not fire |
| `pipe-to-shell`         | high     | `curl` or `wget` piped into a shell or interpreter, `bash <(curl ...)`                                                                                                                                                                                                                     |
| `aws-mutation`          | high     | `aws` create, delete, put, update, `s3 rm/mv`, uploads to S3 and similar write verbs                                                                                                                                                                                                       |
| `recursive-delete-home` | high     | `rm -rf` of `~`, `$HOME`, `/` or a top-level home directory                                                                                                                                                                                                                                |
| `iac-apply`             | high     | `terraform`, `terragrunt`, `tofu` apply, destroy, import, state rm/mv                                                                                                                                                                                                                      |
| `dotenv`                | medium   | `.env` files except `.env.example`, `.sample`, `.template`                                                                                                                                                                                                                                 |
| `file-upload`           | medium   | `curl` uploading a file (`-F`, `-T`, `-d @file`)                                                                                                                                                                                                                                           |
| `git-force-push`        | medium   | `git push --force`, `-f`, `+ref` (not `--force-with-lease`)                                                                                                                                                                                                                                |
| `k8s-write`             | medium   | `kubectl` write verbs, `helm install/upgrade/uninstall/rollback`                                                                                                                                                                                                                           |
| `gh-write`              | medium   | `gh` merge, create, close, comment, secret set, `gh api` with a write method or fields                                                                                                                                                                                                     |
| `mcp-outbound`          | medium   | MCP tools whose name sends, forwards, replies, shares, publishes, deletes or removes (read-style names excluded)                                                                                                                                                                           |

Path-style rules skip the keys `pattern`, `description`, `prompt`, `content`, `old_string`, `new_string` and `todos`, so a Grep pattern, a sub-agent prompt or a document being written does not alarm, while a Grep `path`, a Read `file_path` and a Bash `command` are still scanned. `secret-literal` scans everything.

`sensor-tamper` also fires when your own skills edit `~/.claude/settings.json`. That is intended: an injected agent would do the same.
