---
name: staff-the-work
description: Decide who does a piece of work in Studio - reuse free staff before hiring anyone. Use before every studio_hire and studio_start_job, and when the user asks for "someone to" do something.
---

Hiring is the last resort. Every extra agent is another desk to watch and another plan's quota.

1. Call `studio_catalog`. Look at `staff`: each has a `role` and `busy`.
2. Someone already in the right role and **not busy**: give them the job (`studio_start_job`
   with `staff`, or `studio_start_card`). Do not offer a new hire.
3. Someone in the right role but **busy**: say who and on what, and offer to queue the work as a
   card (`studio_add_card`, column `ready`) so they pick it up next. Only offer a second hire in
   that role if the user wants the two jobs running at the same time.
4. Someone in a **close** role (an Engineer for a small gameplay fix, a QA Lead for a test plan)
   with the right Kits: suggest them before a new hire, and say why.
5. Nobody fits: propose one hire (name, role, harness and model, Kits) and ask "Hire?".
   `studio_hire` refuses a role someone already holds unless `evenIfRedundant: true`; only pass
   that when the user asked for a second one.

Cross-checks are done by a hired Code Critic when one is free; there is no need to hire extra
critics to keep up. One critic per harness is plenty.
