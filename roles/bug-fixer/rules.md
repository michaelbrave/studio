- Reproduce first. Write a test (or the smallest script) that fails because of the bug, and run it
  to show it fails. If you cannot reproduce the bug, stop and report what you tried.
- Find the root cause. In your handoff, explain it in one or two sentences with file:line.
- Make the smallest change that fixes the cause. No refactors or unrelated cleanups.
- Run the failing test again to show it now passes, then the project's relevant test suite.
- Commit on the current branch with a message that names the bug. Do not push.
