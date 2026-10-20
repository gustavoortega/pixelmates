# The status line wrapper is a second Claude provider, and its restore source is the chained command

Claude Code pipes a JSON to the `statusLine.command` in `~/.claude/settings.json` on every refresh, and that JSON
carries the official 5-hour and weekly limits (`rate_limits.five_hour` and `rate_limits.seven_day`). The token ledger
can only estimate those windows from transcripts. To read the official numbers, Pixel Agents chains a wrapper,
`~/.pixelmates/hooks/statusline-tee.js`, in front of the user's status line command:
`node "<wrapper>" '<original>'`. The wrapper runs the original untouched and posts the two windows, and nothing else,
to `POST /api/statusline/claude-statusline`.

## Decision

**The wrapper is a provider of its own**, `claudeStatuslineProvider` (`id: 'claude-statusline'`,
`defaultEnabled: false`), registered beside `claudeProvider`. Its `installHooks` chains the wrapper, `uninstallHooks`
restores the status line, `areHooksInstalled` asks whether `statusLine.command` is ours, `consentDisclosure` states
what changes, what is sent and how to undo it; every member that only means something for hook events is inert. That
reuses, unchanged, everything the hooks consent already proved: the gate, the executor and its process-wide queue,
the per-provider `hooksConsent` / `hooksEnabled` records, the four wire messages, the webview's per-provider ask queue
and the Settings checkbox bound to install state.

**Off by default, asked on a toggle.** `defaultEnabled: false` makes the absent preference read off, so the handshake
never asks about the wrapper. A Settings toggle-on over an unanswered ask records the preference and sends the ask
instead of installing (only for off-by-default providers: the hooks keep docs/adr/0001, where their toggle click is the grant); an Install answer installs through the executor, and
a "Not Now" takes back the preference the toggle raised (docs/adr/0001, last column).

**The restore source is the chained command itself.** The wrapper's single argument is the original command, quoted
for `sh`, so uninstall parses it back out and writes it to `statusLine.command`, keeping every other field as it is
now; a wrapper installed over no status line takes the whole key with it. A status line that is not ours by the
identity rule (the hook script's rule, plus an argument that is nothing or exactly one single-quoted word) is never
written to: the user changed it after the install, and anything written back would be a guess.

## Considered options

- **Save the original statusLine in `~/.pixelmates/config.json`.** Rejected: `readConfig` drops keys it does not
  know and `writeConfig` swallows its errors, so the saved copy could vanish or never land, and a restore from it
  would overwrite whatever the user changed since. The chained command cannot drift from what the file says, and it
  stays readable to the user.
- **Fold the wrapper into the hooks provider.** Rejected: one consent record would cover two different data
  surfaces (hook events, and the limits), and the off-by-default wrapper could not be declined apart from the hooks.
- **A second consent domain or a new wire message for the wrapper.** Rejected: a second dispatcher branch is a second
  gate to drift, which is the failure docs/adr/0001's shared modules exist to prevent.

## Consequences

- One write path for both installers: the wrapper installer goes through `mutateClaudeSettings` (exclusive-create
  one-time backup, atomic tmp + rename, re-read verify). The backup rule counts a status line as ours only in the
  shape the installer creates from nothing, so a file holding our hooks and that wrapper takes no backup of itself.
- The wrapper must keep working without the app: removing the extension restores the status line, but the npm CLI
  has no uninstall hook, so the script stays in `~/.pixelmates/hooks` and, with no server answering, just runs the
  original.
- The privacy promise has two halves: the wrapper builds its body from the two windows, and the route refuses (400)
  any body with another key instead of trimming it.
- POSIX only for now: the original runs through `sh`, so the install refuses on Windows.

Follow-up, not in this change: the per-session status line fields (prompt cache, PR, effort, fast mode, thinking,
context window, agent name) need their own decision, since forwarding them contradicts the two-window body, the
route's contract and the disclosure, no UI decision says where each would render or how the context window would
coexist with the hook-fed gauge, and `pr.url` names the repository.
