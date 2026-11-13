- Some destructive commands are blocked: recursive force deletes, force pushes, `git reset --hard`,
  `git clean -f`, `sudo`, and reading or editing `.env` files. Do not look for ways around a block.
- If a task truly needs one of them, stop and explain why in your handoff instead.
- Committing, running the tests, and read-only commands (`git status/diff/log/show`, `ls`, `cat`,
  `grep`, `sed -n`) run without asking. Other shell commands wait for a person's approval, so
  change files with your edit tools rather than `sed -i` or scripts, and keep scratch work inside
  your worktree.
