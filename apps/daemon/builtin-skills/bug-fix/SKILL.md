---
name: bug-fix
description: Fix bugs systematically - reproduce, find the root cause, make the smallest fix, and lock it in with a regression test. Use for any task that reports something broken, an error, a crash, wrong output, a failing CI run, or a regression.
task-types: [bug]
---

# Bug fix

A bug is fixed when you can show it failing, explain why, and show it passing for that reason. Guessing at fixes until the symptom disappears is not done.

## 1. Understand the report

- Write down, for yourself, the expected behaviour, the actual behaviour, and the exact steps or input. Use the task text, comments, screenshots, logs and CI output.
- If the expected behaviour is genuinely unclear (two reasonable readings), call `ask_question` instead of picking one.

## 2. Reproduce it before touching code

- Find the narrowest way to trigger it: an existing test, a new failing test, a small script, a request to the running `preview`, or a database query.
- Prefer a failing automated test in the project's test framework. Run it and confirm it fails for the reported reason (not because of a typo in the test).
- If you cannot reproduce it, say what you tried in your summary and ask, rather than shipping a speculative fix.

## 3. Find the root cause

- Read the code path end to end. Check recent history for the area: `git log -p --since=... -- <files>` and `git blame` often show the change that introduced it.
- Add temporary logging or assertions if needed; remove them before you finish.
- Ask "why" until you reach the decision that is actually wrong (a wrong assumption, a missing case, an off-by-one, a race, bad data). The line that throws is often not the cause.

## 4. Fix the cause, minimally

- Change as little as possible to correct the wrong decision. No drive-by refactors or unrelated cleanups in the same change.
- Handle the whole class of input, not just the one example from the report (e.g. all empty values, not just `""`).
- If data in the database is already wrong because of the bug, say so and propose (do not silently run) a backfill.

## 5. Prove it

- The reproduction test now passes, and it would fail if the fix were reverted. Keep it as a regression test with a name that describes the behaviour.
- Run the full checks. Search for the same pattern elsewhere (`grep` for the function, the same mistake in sibling code) and mention other affected places.

## Summary to write

1. What was broken and how to reproduce it.
2. The root cause, in one or two sentences.
3. The fix and why it addresses the cause.
4. The regression test and any other places with the same problem.
