---
name: review-checklist
description: Review a specific commit against its job brief and acceptance criteria. Use when asked to review, critique or check a change.
---

Review exactly the commit you were given (`git show <sha>`), not the working tree.

1. **Inputs.** Name the commit, the brief and its acceptance criteria. If any are missing, say
   "NOT ASSESSED" for what depends on them instead of guessing.
2. **Acceptance.** For each criterion: met / not met / cannot tell, with evidence (file:line,
   command output).
3. **Correctness.** Look for wrong results, crashes, unhandled states, broken edge cases, and
   regressions in callers of changed code. Every finding needs a concrete triggering scenario.
4. **Tests.** Do the tests exercise the change? Would they fail if the change were reverted?
5. **Scope.** Changes unrelated to the brief are findings too.

Rank findings most severe first. Separate **defects** (something goes wrong) from **suggestions**
(could be clearer or simpler). Do not present style preferences as defects. If the change is
fine, say so plainly.
