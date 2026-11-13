---
name: design-section
description: Write or revise one section of a game design document (a mechanic, system or feature). Use when asked to design or specify gameplay.
---

Work backwards from the player: what should they feel, what do they do moment to moment, and
what rules make that happen. Each section uses these headings:

1. **Player experience.** The moment(s) this creates, in one or two concrete sentences.
2. **Loop.** How it fits the moment-to-moment loop (seconds), the goal/reward loop (minutes), and
   the session loop. Every mechanic should serve at least one of them.
3. **Rules.** Inputs, outputs, states and transitions, precise enough to implement without guessing.
4. **Tuning knobs.** Every number a designer may want to change, with a starting value and a range.
   Implementers read these from data, not code.
5. **Edge cases and degenerate play.** Exploits, dominant strategies, softlocks, and what happens in
   each. Distinguish healthy mastery from a broken strategy.
6. **Dependencies.** Other systems this reads from or writes to.
7. **Acceptance criteria.** Testable statements: "pressing jump within 100 ms of leaving a ledge
   still jumps", not "jumping feels good".
8. **Open questions.** Anything only the user can decide. Do not invent answers to them.
