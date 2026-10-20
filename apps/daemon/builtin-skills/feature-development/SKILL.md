---
name: feature-development
description: Build a new feature end to end - clarify acceptance criteria, design within the existing architecture, implement in small steps, and cover it with tests and docs. Use for tasks that add new capabilities, screens, endpoints, commands or integrations.
task-types: [feature]
---

# Feature development

## 1. Pin down what "done" means

- List the acceptance criteria from the task. If they are missing, derive them from the description and state them at the top of your summary.
- Ask with `ask_question` when a product decision is needed (who can do this, what happens on error, what the default is). Do not invent product rules silently.

## 2. Fit the existing design

- Find the closest existing feature and follow its structure: where routes, services, components, tests and types live; naming; error handling; data access.
- Reuse existing helpers, components and patterns. A second way of doing the same thing is a review finding.
- Sketch the change: data model, API/contract, UI, and the order you will build them. If it touches the database, use the database-migrations skill.

## 3. Build in small, working steps

- Start from the data or contract layer, then the logic, then the UI.
- Keep each step compiling and tests passing. Commit-sized steps make review easier even though Nightshift commits for you.
- Handle errors, empty states, permissions and limits, not only the happy path.

## 4. Tests and docs

- Add tests for each acceptance criterion and the important edge cases, at the level the project already uses (unit, integration or end-to-end).
- Update types, API docs, README sections or user-facing copy that the feature changes.
- For UI, follow the frontend-design skill and check the screen in the preview.

## 5. Finish

- Run the checks. Re-read your diff as a reviewer: remove debug code, dead code and unrelated changes.
- Summary: what the feature does, the acceptance criteria and how each is met, how to try it, and any follow-ups you left out on purpose.
