<h1 align="center">pixelmates</h1>

<p align="center">
  <img src="docs/images/hero.png" alt="Four agents in the Studio room: one typing with an XP pop, one reading, one under a storm cloud, one napping">
</p>

Your Claude Code sessions as a pixel office. Each session is a character at a desk: it types while the agent works, reads or naps while it waits for you, and levels up as it ships.

This is a fork of [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) by Pablo De Lucca (MIT). The engine, hooks and layout editor come from upstream. The differences are below.

## What this fork changes

**Art.** Every sprite is drawn by code in `scripts/cozy-art` at 2x density: 12 characters, 41 furniture sprites, floors, walls, rugs, pets. No paid asset pack. `npm run cozy:assets` regenerates them byte for byte.

**A crew that remembers.** Sessions claim a member from `~/.pixelmates/roster.json` and keep its name, look and XP across restarts. XP pays for real work, read from the session's own transcript: a commit +60 (at most 3 per turn, an amend pays nothing), a PR created +120, a PR merged +200, tests going green after an edit +40 (at most once per turn). Turns, tool calls and sub-agents pay nothing, and a session without a transcript (a hooks-only provider) stays at its level. Level N to N+1 costs `round(100 * N^1.5)`.

**Idle looks idle.** Status comes from the tail of the transcript, so a session that finished an hour ago does not sit there typing. Waiting agents read a book, nap after 10 minutes, or walk to the lounge for coffee. Sub-agents show up as gray helpers next to their parent.

**Rooms per project.** Map workspace folders to Areas and each project gets its own room. The camera frames the rooms where someone is working.

**Model at a glance.** Haiku, Sonnet, Opus and Fable each get a badge color, an accessory and a desk companion (bird, cat, owl, dragon).

**Token usage.** The Usage panel ranks rooms and sessions by tokens in the current 5-hour block and the week, weighted by cost. Budgets are optional.

**Official limits.** Turn on "Claude status line (official limits)" in Settings to see Claude Code's own 5-hour and weekly usage in the Usage panel and the HUD, with the pace you are on. It wraps your status line command, which keeps running unchanged, and sends only those two numbers to the local server. macOS and Linux for now.

**Tripwires.** 14 rules flag risky tool calls with an alarm on the agent: credential and key reads, `curl | sh`, force pushes, `rm -rf ~`, cloud and cluster writes, tampering with the hooks. Matched text never leaves the local server. See [docs/tripwires.md](docs/tripwires.md).

**Who needs a look.** A character smokes when its tests keep failing with no edit in between, or when it repeats the same call four times; a pause mark means its turn has been silent for 10 minutes; it goes gray when its Claude Code process is gone. Hover it for the reason. Gray external sessions leave after 5 minutes and come back if resumed.

**Day and night.** Light follows your clock: window light in the morning, a darker room at night lit by the lamp, the active monitors and the fairy lights.

**Security fixes over upstream.** The standalone WebSocket requires the session token. On a loopback bind the server refuses any `Host` that is not `127.0.0.1`, `localhost` or `::1`, which blocks DNS rebinding. Bash activity shows the program name, not the full command line.

## Run it

Requirements: Node.js 20+, [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

```bash
git clone https://github.com/gustavoortega/pixelmates.git
cd pixelmates
npm install
npm run build
node dist/cli.js --host 127.0.0.1
```

Open the URL it prints. It carries a `?token=` that gives full control of the office, including installing the Claude Code hooks, so treat it as a password. The first run asks before it touches `~/.claude/settings.json`.

The token is saved in `~/.pixelmates/server-token` and the port the server picked in `~/.pixelmates/server-port`, so the URL keeps working after a restart and an open tab reconnects on its own. If that port is taken, the server uses another one for that run and tries the saved one again next time. The saved token is a long-lived password: `node dist/cli.js --new-token` replaces it and every URL with the old one stops working; under `--host 0.0.0.0`, rotate once you have shared the URL. `--token <token>` uses a token for a single run and leaves the saved one alone.

Keep the default bind. `--host 0.0.0.0` puts the office and its token-gated socket on your network.

For VS Code, open the repo and press F5. The extension is not published.

### Layout

A fresh install opens the cozy office (Studio, Lab, Den, a lounge and a cat). If you already have `~/.pixelmates/layout.json`, it is kept. To switch to the new office, back it up and delete it:

```bash
mv ~/.pixelmates/layout.json ~/.pixelmates/layout.json.bak
```

Click **Layout** to edit rooms, furniture, rugs and Areas.

## Memory for Claude (MCP)

The plugin in `plugin/` gives Claude Code a read-only memory of your past sessions on this machine. Claude can answer "what did I do this week" for a sprint update, "did I already look into X", and "is another session editing this file right now", with four tools: `recent_work`, `find_past_work`, `active_now` and `recent_work_all_projects`.

How it treats your transcripts:

- It reads `~/.claude/projects` when a tool is called and keeps nothing. One stdio process per session, no network, no listener.
- The project tools read only the transcripts of the working directory. The all-projects tool asks you on every call.
- It returns prompts you typed, final answers, titles, commits, PRs, file paths and test verdicts. Tool output, tool inputs and thinking never leave the transcript.
- Every string is redacted for secrets before it is returned, and search runs on the redacted text.
- Its log on stderr carries counts only.

Install:

```bash
claude plugin marketplace add gustavoortega/pixelmates
claude plugin install pixelmates@pixelmates
```

From a clone, for one session: `claude --plugin-dir ./plugin`.

Plugins cannot ship permission rules, so every call prompts until you allow the three project tools in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_pixelmates_memory__recent_work",
      "mcp__plugin_pixelmates_memory__find_past_work",
      "mcp__plugin_pixelmates_memory__active_now"
    ]
  }
}
```

Never allow `recent_work_all_projects`: it reads every project under a directory, and the prompt is the point.

The office app is separate in v1: the plugin neither starts it nor installs its hooks.

## Development

```bash
npm run check-types
npm run lint
npm test
```

The hero image comes from a staged scene in the dev server:

```bash
cd webview-ui && npx vite --host 127.0.0.1 --port 5199
# open http://127.0.0.1:5199/?scene=hero&hud=0
```

`npm run e2e:perf` measures what the dev scenes cost per second (frames drawn, animation frames requested, main-thread time): `?scene=hero`, the default mock and `?scene=empty`, an office where nothing moves.

[CLAUDE.md](CLAUDE.md) documents the architecture, [docs/cozy-art.md](docs/cozy-art.md) the art generator.

## License

MIT, same as upstream. See [LICENSE](LICENSE).
