# Project idea and decision record

This applies to every agent and harness working in this repository: Claude Code, Codex,
OpenCode, Hermes, agents dispatched by Studio itself, and people.

[docs/IDEAS.md](docs/IDEAS.md) records where Studio's ideas come from and why we chose
them. Keep it current as part of the work, not as an afterthought.

## When to add or update an entry

Before you finish a task, ask: did this adopt, materially change, or reject a product,
architecture, visual, or workflow idea? If so, update docs/IDEAS.md **in the same change**
(the same commit or PR as the code or docs it explains). This includes:

- a new feature, or a feature that is removed or substantially reworked;
- a design choice between real alternatives (record the rejected ones too);
- an idea the user brings in from another project, product, video, post, or person;
- an idea proposed in conversation that the user accepts, rejects, or defers;
- a change to how we work (workflow, review, release, tooling conventions).

Routine fixes, refactors, and dependency bumps do not need entries.

## How to write it

- Follow "How to keep this record" and the template in docs/IDEAS.md. Use the next
  free `IDEA-NNN` number; never renumber existing entries.
- Credit who proposed the idea (the user, a named agent/harness, or a project) and link
  sources. Distinguish inspiration, adaptation, direct code/asset reuse, and dependencies.
  For reuse, identify the original files and keep their license notices.
- When the user brings in outside material (a repo, zip, post, video, or document), ask for
  or record its address and author at that moment. Don't guess a source from a file name.
- Write the user's actual reasoning where they gave it; quote briefly when the wording matters.
  Mark your own reconstructed reasoning or inference as such.
- Date entries with the local date the decision was made. Do not invent prior
  conversations, sources, or dates; write "unknown" instead.
- When a decision changes, add a dated **Updates** line or a successor entry that references
  the old one. Preserve the earlier reasoning instead of rewriting it as today's view.
- Link the resulting work: files, docs sections, commits, PRs. Say whether it is planned
  or shipped.
- If you cannot tell whether something warrants an entry, add a short one or mention it in
  your final summary so the user can decide.
