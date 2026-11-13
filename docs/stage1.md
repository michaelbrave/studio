# Stage 1: complete work loop (plain UI)

Exit (PLAN.md §11): a real change runs on a selected worker and becomes a reviewed, integrated
result, with its execution, artifact, feedback, and recovery history retained.

## Verified 2026-10-28 (local worker, sandbox project)

1. **Plan.** The Producer (Claude, read-only) read the project and proposed three cards, each
   assigned to a role with acceptance criteria; they landed in the board's Proposed column.
2. **Board.** One card approved to Backlog and started: a Software Engineer job on Claude, with the
   role's default Kits and a memory brief from the vault. The card moved to Doing, then Review.
3. **Cross-check.** A Code Critic on Codex reviewed the branch in its own worktree, ran the tests,
   confirmed the exact commit (`bb1a8d7`), and approved.
4. **Accept and integrate.** Accepted, then the Integrator merged the branch into `main` in the
   project's own checkout (`git merge --no-ff --no-commit`, MERGE_HEAD checked against the
   reviewed commit, tests on the merged result, then commit `e591381`). The job became
   integrated and the card moved to Done.
5. **Feedback.** A 5★ coding rating with a note: on the leaderboard, and in the role's feedback page
   in the vault, which the next engineer job's memory brief includes.
6. **History.** Vault git: immutable job records, project notes, cards. Hub DB: every state
   transition, approval, re-read and note per Attempt.

## Found along the way

- T3 0.1.3 has no local merge (only push + pull request), so integration is an agent job with hub
  preconditions: checkout clean and on the base branch, one integration per project at a time.
- An agent without the Handoff Kit (the Integrator gets no Kit files in your real checkout) wrote
  the fields without the `## Handoff` heading. The brief now carries the exact block, and the parser
  reads headingless fields.

## Not yet

- Conflicts are reported and backed out, not resolved; resolving one needs a new attempt and review.
- Ratings are per Attempt and Role; Staff (persistent named agents) come later.
- The Librarian (merging inbox notes into wiki pages) is Stage 3; briefs use the latest notes.
