# Known issues

## Desk chat stops showing the agent's replies (2026-11-14) — fixed

**Seen in:** the Studio Manager chat (the desk), during a long session that set up a game jam
project. The user's messages still reached the agent and it kept working, but its replies stopped
appearing in the chat.

**Cause:** T3's `t3_thread_read` pages a thread's timeline **from the start** (`afterPosition`,
`nextPosition`, `hasMore`). Studio asked for `limit: 100` without a position, so it always got the
*first* 100 items. Once a chat passed 100 timeline items (tool calls count), nothing new was ever
shown. The chat that hit it had 316 items. The same mistake affected:
- the job panel's activity (first 50 items),
- the "doing" line over each agent (always the same first 3 items),
- the handoff reader (first 20 messages, so a long job's final handoff could be missed and logged
  as "no handoff report found"),
- project lists (`t3_project_list` returns 20 per page).

**Fix:** `readTail` and `listProjects` in `apps/hub/src/t3Worker.ts` read the end of a thread and
every page of projects. Tests: `apps/hub/test/t3read.test.ts`.

## T3: clicking a folder seemed to reset the chat and project history (2026-11-14) — not reproduced

**Seen in:** T3's own UI, while a Studio desk chat was going. After clicking a folder control,
the visible chat and project history looked reset.

**What we know:** Studio's chats are recorded in the hub's database by T3 thread id (`chats`
table), so Studio's list of chats is not affected by what T3's sidebar shows. The desk chats live
in a T3 project called "Studio desk" (folder `~/.config/studio/desk`); selecting another project
or folder in T3 shows that project's threads instead, which can look like a reset.

**What Studio does now:** every chat and every agent has an "Open in T3 ↗" link that opens that
exact thread in T3, so there is no need to find it through T3's sidebar.

**To reproduce:** in T3, with a Studio desk chat open, click the folder/project control in the
sidebar, then check whether the "Studio desk" project and its threads are still listed (T3
`t3_thread_list` for that project). If threads are really gone (not just hidden), that is a T3
issue to report upstream.

## Agents that hit a plan limit stayed failed (2026-11-14) — fixed

A job that failed (for example on a subscription limit) was terminal: Studio stopped watching
its thread. There is now a Restart (over the agent in the office, in the Staff list, and in the
job panel, plus `studio_restart` for the Studio Manager). It sends the agent back to work in the
same thread and worktree, puts its Kit back, and watches the thread again. The plan meter
(bottom right) shows how much of each plan is left before you restart.
