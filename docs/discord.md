# Studio on Discord (through Hermes)

Studio tells you on Discord when an agent needs you, finishes, fails, hits a usage limit, or a
machine drops off. You can ask the bot what's going on, and approve or deny an agent's pending
request by replying. No phone app beyond Discord, no text messages.

```
Studio hub ──signed webhook──▶ Hermes gateway ──deliver_only──▶ your Discord channel
     ▲                              │
     └──── MCP (/mcp, token) ◀──────┘  when you ask or reply ("approve it")
```

- **Notifications** cost no model tokens: Hermes forwards Studio's line as-is (`deliver_only`).
  Each message also lands in the chat's history (`mirror_to_session`), so "approve it" has context.
- **Asking and approving** goes through the Hermes agent, which calls Studio's tools:
  `studio_status`, `studio_waiting`, `studio_brief`, `studio_job` (read-only) and `studio_respond`.
  Hermes treats Studio as `trust: untrusted`, so it asks you to confirm every `studio_respond`
  before it runs. Every answer is logged in the job's history as "from Discord (Hermes)".
- **Morning brief**: once a day (08:00 by default) one message with what finished, failed, was
  accepted or merged since the last brief, and what stands now: waiting for you, ready for your
  review, working, proposed cards, machines offline. Built from Studio's own records, so no model
  tokens and nothing guessed. Ask "catch me up" any time for the same thing (`studio_brief`).
- Not possible from Discord, on purpose: starting jobs, planning, accepting or integrating.

## Already set up (2026-11-07)

- Studio: `~/.config/studio/notify.json` (webhook URL + secret) and `~/.config/studio/mcp-token`,
  both owner-only. The hub reads them at start; `Notifications: ...` in its log means it's on.
- Hermes: `~/.hermes/config.yaml` has a `studio` webhook route (127.0.0.1:8644) and a `studio` MCP
  server; the secrets are `STUDIO_WEBHOOK_SECRET` and `STUDIO_MCP_TOKEN` in `~/.hermes/.env`.
  Backups from before the change: `~/.hermes/backups/*.pre-studio-2026-11-07`.
- `hermes mcp test studio` connects and finds the 5 tools.

## Your steps: the Discord bot

1. Make a private Discord server for Studio (just you), with a channel such as `#studio`.
2. At https://discord.com/developers/applications: **New Application** → **Bot** → turn on
   **Message Content Intent** and **Server Members Intent** → **Reset Token** and copy it.
3. Run `hermes gateway setup`, pick **Discord**, paste the token. It checks the token, prints an
   invite link for your server, and allowlists you as the only user.
4. Open the invite link, add the bot to your private server.
5. `studio/deploy/studioctl on` (starts the Hermes gateway with Studio, and at boot).
6. In `#studio`, type `/sethome`. Studio's messages go to the home channel.
7. Say "what's going on in Studio?" to check the bot can reach Studio.

The Hermes model must be able to call tools for asking and approving. If replies ignore Studio,
switch Hermes to a stronger model (`hermes model`); notifications work regardless.

## Changing or turning it off

- Brief time: add `"brief": "07:30"` to `~/.config/studio/notify.json` (local time), or
  `"brief": false` for no brief; then `studioctl restart`. If the PC was off at that time, the
  brief goes out when Studio starts, up to 4 hours late; after that the day is skipped.
  Preview it without sending: http://127.0.0.1:4600/api/brief

- Notifications only, no chat control: set `enabled: false` under `mcp_servers.studio` in
  `~/.hermes/config.yaml`, then `studioctl restart`.
- No notifications: delete `~/.config/studio/notify.json`, then `studioctl restart`.
- Everything: `studioctl off` stops Studio, T3 and the Hermes gateway.
- New secrets: delete `~/.config/studio/mcp-token` (the hub makes a new one at start) and put the
  new values in `~/.hermes/.env` and `notify.json`.
