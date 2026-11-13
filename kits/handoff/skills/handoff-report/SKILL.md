---
name: handoff-report
description: Write the end-of-job handoff report Studio reads to review your work. Use when you finish or stop a job.
---

End your final message with this block, filled in. Studio parses it; keep the headings exactly.

```
## Handoff
Status: done | partial | blocked
Commit: <full sha of your final commit, or "none">
Acceptance:
- [x] <criterion> — <evidence: command + result, or file:line>
- [ ] <criterion> — <why not met>
Checks run:
- `<command>` → <pass/fail, short summary>
Not verified: <anything you could not check>
Notes for the reviewer: <one to three lines>
```
