---
name: break-down
description: Break a goal into task cards for the studio board, each assigned to one role with acceptance criteria. Use when asked to plan, scope or split work.
---

1. Read enough of the project to plan against reality: README, design docs, the code layout,
   recent commits. Note what already exists so you do not plan work that is done.
2. Split the goal into cards. A good card is one job for one role: finishable in a single
   session, with a result someone can review. Prefer 3–8 cards; split further only if a card
   would touch unrelated areas.
3. Assign each card to exactly one role from the roster in your brief, by what the work needs:
   design questions to design roles, code to programming roles, test plans to QA.
4. Order cards so each one's inputs exist when it starts. Use `depends_on` with earlier titles.
5. Write acceptance criteria someone else can check without asking you.

End your final message with exactly one fenced block tagged `cards`, before the handoff:

```cards
- title: Short imperative title
  role: role-name-from-the-roster
  priority: high | normal | low
  depends_on: []            # titles of earlier cards
  description: |
    What to do and why, in a few sentences.

    Acceptance criteria:
    - A checkable statement
```

Questions only the user can answer go under "Notes for the reviewer" in the handoff, not into cards.
