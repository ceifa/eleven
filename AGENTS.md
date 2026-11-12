# eleven

## Language

**Everything in this repo is written in English.** Code, comments, docs, tests,
and — no exceptions — **git commit messages** (subject and body). This holds even
when the conversation with the user is in Portuguese.

## Layout

A message's path through the daemon, and where each step lives:

- `src/daemon.ts` wires everything: config, gateway, channels, reply delivery, dashboard.
- `src/channels/` — chat platforms. A platform is a `bot.ts` (how its chat is
  read and written) plugged into two shared pieces: `Conversations`
  (`conversations.ts`: bursts, turns, failover retries, wake-ups, commands,
  pairing) and `BotChannel` (`bots.ts`: one bot per configured channel, calls
  routed by session key). `turn.ts` runs one chat turn end to end; `replies.ts`
  delivers saved final answers. New platform behaviour that is not about the
  platform's own API belongs in the shared pieces, not in a `bot.ts`.
- `src/gateway.ts` — resolves a conversation to a workspace and a thread, runs
  the turn, and announces what happens (`GatewayEvents`). `live-turns.ts` is
  the in-memory record of running turns.
- `src/agent/` — the runtimes. `runner.ts` owns sessions and the failover loop;
  `turn.ts` is the vocabulary everything else shares (request, events, result,
  failure). `prose.ts`, `context.ts`, `handoff.ts` and `skills.ts` are the
  runner's parts. `claude-code.ts` is the Claude Code provider, with the child's
  environment in `claude-env.ts` and its input in `claude-input.ts`.
- `src/threads/` — what is on disk: the thread index, transcripts, the
  pending-turn ledger, usage, search, garbage collection.
- `src/dashboard/` — `server.ts` composes it; the API is a route table
  (`api.ts`, `router.ts`, handlers by resource in `routes/`); `broadcast.ts` is
  the websocket; `assets.ts` serves `public/`.
- `src/dashboard/public/` — the browser app: native ES modules, no build step.
  `app.js` is the entry point; one module per view or concern. A new module
  must be added to `SHELL` in `sw.js` and to `shell-files.ts`.

## Checks

`npm run check` and `npm test`. Never run `node src/cli.ts start` from a
checkout without `--foreground` and both `ELEVEN_CONFIG_DIR` and
`ELEVEN_STATE_DIR` pointing at scratch directories: it stops the live daemon.
