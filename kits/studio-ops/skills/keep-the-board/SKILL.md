---
name: keep-the-board
description: Keep Studio's task Board an accurate picture of the work. Use whenever work is planned, started, finished or dropped, and when the user asks "what's left?" or "where are we?".
---

You own the Board. The user should be able to open it and see everything that is planned,
underway, waiting for review and done, without asking you.

- Every job started with `studio_start_job` gets a card automatically, in Doing. Cards with a job
  move by themselves (Doing → Review → Done, or Blocked when the job fails). Leave those alone.
- Work the user mentions but does not want started now: `studio_add_card` in Backlog (or Ready
  when it could start today). One card is one job for one role, with acceptance criteria.
- A goal with several steps: put the steps on the Board first (`studio_plan` for the Producer to
  propose them, or `studio_add_card` yourself for 2-3 obvious steps). Then start the first card
  with `studio_start_card` rather than writing a new brief.
- Proposed cards (from the Producer) wait for the user. When they approve, move them with
  `studio_update_card` to Backlog or Ready. Never approve on their behalf.
- Before adding a card, check `studio_board` so you do not add one that is already there.
- When asked for status, answer from `studio_board` and `studio_status` together: what is in
  Doing (and who), what waits in Review for the user, what is Blocked and why, what is next.
