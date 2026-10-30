# eleven

A featherweight personal AI gateway. Channels, model providers, workspaces, threads. Nothing else.

eleven connects chat channels to agents running in your local directories, with a web dashboard to configure everything and browse every conversation. It uses the [pi SDK](https://github.com/badlogic/pi-mono) for 30+ model providers and can also run the official Claude Code runtime through Anthropic's Agent SDK, reusing a local Claude subscription login. Born as a lighter alternative to [OpenClaw](https://github.com/openclaw/openclaw).

The idea is simple: eleven makes your local agent reachable from anywhere, through any chat channel you wire up, so you can talk to it from your phone or a group when you are away from your machine. It has **no memory, no cron, no scheduler, no plugin system of its own**, nothing beyond the gateway itself. Everything lives in the workspace: `AGENTS.md` and skills reach both runtimes, while Pi-backed models also retain Pi extensions unchanged.

![eleven dashboard: live conversation view](https://raw.githubusercontent.com/ceifa/eleven/main/assets/dashboard-threads.jpg)

## What it does

- **Channels**: connect your agent to any channel, including Telegram and Discord.
- **Pairing**: deny-by-default everywhere. Unknown DM senders and unregistered groups show up as requests in the dashboard; one click adds them to the allowlist.
- **Workspaces**: a directory + tool policy (`read`-only to full `bash`) + optional model override. pi loads the workspace's `AGENTS.md` and `.agents/skills` natively, so your agent's persona lives in the repo, not in eleven.
- **Dashboard** (`127.0.0.1:1111`): configure channels, providers, workspaces, approve pairings, and browse or join any thread with live streaming. Threads are named after the conversation they belong to — the forum topic, the group, the person — searchable full-text across every transcript, stoppable mid-turn, and restartable in place — "New thread here" is `/new` for the conversation you are reading, so a forum topic can be started over without leaving the browser — and every thread can show the skills its workspace loads. Its composer attaches files (pick, drop, or paste a screenshot) and records voice messages, transcribed the same way a Telegram voice note is.
- **On a phone**: the same dashboard on a 390px screen — the list and the conversation become two screens the back gesture moves between, the composer stays above the keyboard, and it installs to the home screen as a PWA (Settings → App). Its interface is cached, so it opens with no signal; the conversations in it still need the daemon.
- **Voice conversation**: hands-free talk with a workspace from the dashboard — speak, pause, hear the reply, speak again. Built for a phone in the car: no taps between turns, a tone when it is listening, and the agent's turn keeps running if you pause. It uses the transcription command for your side and either the device's own voice or a `speech` command you configure for the agent's. The page has to stay open and the screen on: a browser cannot keep the microphone in the background or take Bluetooth buttons.
- **Models**: any provider pi supports, plus the official Claude Code runtime.
- **Usage**: where the tokens actually went — per day, per model and per thread, with the cache hit rate, the list price at each provider's published rates, and how many prompt tokens came in cold because a turn idled past the cache TTL or fell down the sequence onto another model. Read off the transcripts on disk, so there is no meter to keep in sync, and whatever quota windows a provider reports sit on the same page.

![eleven dashboard: workspace configuration](https://raw.githubusercontent.com/ceifa/eleven/main/assets/dashboard-workspaces.jpg)

## Install

Requires Node ≥ 24. Pi-backed models use [pi](https://pi.dev) credentials (`pi` → `/login`, or API keys in `~/.pi/agent/auth.json`). Claude Code models reuse the official local login:

```sh
claude auth login
```

```sh
npm i -g @ceifa/eleven
eleven init
eleven doctor
```

Config lives in `~/.config/eleven/eleven.json`, but the dashboard edits it for you, so the fastest path is: `eleven start`, open `http://127.0.0.1:1111`, add a bot token and a workspace.

## Configuration

```json
{
  "dashboard": { "port": 1111, "host": "127.0.0.1" },
  "models": [
    { "model": "openai-codex/gpt-5.6-sol", "reasoning": "high" },
    { "model": "claude-code/opus", "reasoning": "high" }
  ],
  "autoFailover": false,
  "transcription": { "command": "whisper --file {{file}}" },
  "speech": { "command": "my-tts --out {{file}}" },
  "session": { "idleDays": 7, "retentionDays": 30 },
  "workspaces": {
    "agent": {
      "path": "~/my/agent-repo",
      "tools": ["read", "bash", "edit", "write"],
      "channels": [
        {
          "type": "telegram",
          "name": "main",
          "token": "$TELEGRAM_BOT_TOKEN",
          "users": { "123456789": { "name": "me" } },
          "groupAllowedUsers": [123456789],
          "groups": {
            "-1001234567890": {
              "requireMention": true,
              "topics": { "42": { "title": "ops", "models": [{ "model": "claude-code/sonnet" }] } }
            }
          }
        }
      ]
    }
  }
}
```

`models` is an ordered sequence: the first entry leads every turn, the rest are
fallbacks tried in order when it fails. A failed attempt that already ran tools
is never failed over automatically — a rewound transcript cannot undo a command
or a sent message — so the failure comes with two buttons instead: **Continue**
picks the dead turn up where it stopped, **Restart** drops that attempt and runs
the request again from nothing. Either way the rest of the sequence takes over.
`autoFailover` (a toggle on the Models page) skips that question: the next model
picks the turn up on its own, exactly as **Continue** would. Any scope — workspace, group, topic —
may carry its own `models` sequence, and the most specific one replaces the
inherited sequence outright. `tools` narrows capabilities (`read`, `bash`,
`edit`, `write`, and `web`/`agent` on the Claude Code runtime); a workspace's
list is always intersected with the running model's. `users` and `groups` are
the allowlists — empty means deny, and pairing fills them in from the
dashboard. Values written as `"$VAR"` are read from the environment at load
time. `speech` is optional: it gets the reply as plain text on stdin and
writes WAV audio to `{{file}}`.

### Discord

Create an application in the [Developer Portal](https://discord.com/developers/applications),
open **Bot**, turn on **Message Content Intent** and copy the token. Invite the
bot with the `bot` and `applications.commands` scopes and the View Channels,
Send Messages, Send Messages in Threads, Read Message History, Attach Files and
Add Reactions permissions. Then add a channel of type `discord` with that
token; `eleven doctor` tells you if the intent is still off.

The config is the same shape as Telegram's. `users` are the people allowed to
DM the bot. `groups` are servers, keyed by server id, and every channel or
thread in a server is one of its `topics`: each is a thread of its own, and
registers itself (with its name) the first time someone speaks in it. So do
the category a channel sits in and the channel a thread hangs off, each
recorded as the topic's `parent`: instructions set on a category reach every
channel in it, a channel's reach its threads (forum posts included), and the
innermost `models` win. A server
approved from the dashboard hears every message from its allowed users; set
`requireMention` back on and it answers only when mentioned or replied to.
`/new`, `/stop`, `/skills` and `/usage` are native slash commands.
