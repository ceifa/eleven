# eleven

A featherweight personal AI gateway. Channels, model providers, workspaces, threads. Nothing else.

eleven connects chat channels to agents running in your local directories, with a web dashboard to configure everything and browse every conversation. It uses the [pi SDK](https://github.com/badlogic/pi-mono) for 30+ model providers and can also run the official Claude Code runtime through Anthropic's Agent SDK, reusing a local Claude subscription login. Born as a lighter alternative to [OpenClaw](https://github.com/openclaw/openclaw).

The idea is simple: eleven makes your local agent reachable from anywhere, through any chat channel you wire up, so you can talk to it from your phone or a group when you are away from your machine. It has **no memory, no cron, no scheduler, no plugin system of its own**, nothing beyond the gateway itself. Everything lives in the workspace: `AGENTS.md` and skills reach both runtimes, while Pi-backed models also retain Pi extensions unchanged.

![eleven dashboard: live conversation view](https://raw.githubusercontent.com/ceifa/eleven/main/assets/dashboard-threads.jpg)

## What it does

- **Channels**: connect your agent to any channel, including Telegram and Discord.
- **Pairing**: deny-by-default everywhere. Unknown DM senders and unregistered groups show up as requests in the dashboard; one click adds them to the allowlist.
- **Workspaces**: a directory + tool policy (`read`-only to full `bash`) + optional model override. pi loads the workspace's `AGENTS.md` and `.agents/skills` natively, so your agent's persona lives in the repo, not in eleven.
- **Dashboard** (`127.0.0.1:1111`): configure channels, providers, workspaces, approve pairings, and browse or join any thread with live streaming.
- **Models**: any provider pi supports, plus `claude-code/default`, `opus`, `sonnet`, and `haiku` through the official Claude Code runtime. Ordered fallbacks wrap whole turns; Eleven never replays an attempt after a tool has already caused side effects.

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

Config lives in `~/.config/eleven/eleven.json`, but the dashboard edits it for you, so the fastest path is: `eleven start`, open `http://127.0.0.1:1111`, add a bot token and a workspace. Migrating from OpenClaw? `npx eleven import openclaw` brings over your Telegram bot, allowlists, groups, model preferences and voice transcription.

## Configuration

```json
{
  "dashboard": { "port": 1111, "host": "127.0.0.1" },
  "providers": {
    "defaultModel": "claude-code/default",
    "fallbackModels": ["claude-code/sonnet"],
    "thinkingLevel": "high"
  },
  "workspaces": {
    "agent": {
      "path": "~/my/agent-repo",
      "tools": ["read", "bash", "edit", "write", "web", "agent"],
      "channels": [
        {
          "type": "telegram",
          "name": "main",
          "token": "$TELEGRAM_BOT_TOKEN",
          "allowedUsers": [123456789]
        }
      ]
    }
  }
}
```

Workspace capabilities are provider-neutral: `read`, `bash`, `edit`, and `write` map to each runtime's native file tools; Claude Code additionally supports `web` and `agent`. Omitting `tools` enables Eleven's curated set. Claude's cloud scheduling, notifications, worktrees, DesignSync, and native Workflow tools are deliberately unavailable. Channel tools such as `telegram` are exposed only through Eleven's isolated MCP server and appear under their clean names in the dashboard.
