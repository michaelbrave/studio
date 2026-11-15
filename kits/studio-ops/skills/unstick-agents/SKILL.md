---
name: unstick-agents
description: Get failed, stopped or stuck agents in Studio going again. Use when an agent failed, hit a subscription limit, or the user asks why nothing is moving.
---

1. `studio_status` shows each agent's state. Failed and stopped ones are the candidates.
2. `studio_job` with the attempt id shows its history and last activity. Look for the reason:
   a usage or rate limit, a crash, a question it could not ask, a test it could not fix.
3. A usage limit: check `studio_usage`. If that plan's session window is still used up, say when
   it resets and offer to restart then, or to give the card to someone on another harness
   (another free staff member: `studio_start_card` with their `staff` id).
4. Otherwise, with the user's go-ahead, `studio_restart` sends it back to work in the same thread
   and worktree. Pass a `note` when you know what it should do differently.
5. An agent waiting for an approval shows as "needs you". Use `studio_waiting`; only answer a
   request with `studio_respond` when the user said yes to that specific request.

Never restart the same agent more than twice for the same failure without telling the user
what keeps going wrong.
