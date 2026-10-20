export type TaskType = "feature" | "bug" | "improvement" | "refactor" | "design" | "docs" | "test" | "chore" | "review";

export type TaskTypeInfo = {
  type: TaskType;
  label: string;
  description: string;
  guidance: string[];
  review: string[];
  keywords: string[];
};

export const TASK_TYPES: TaskTypeInfo[] = [
  {
    type: "feature",
    label: "New feature",
    description: "Something users can do that they could not before.",
    guidance: [
      "Restate the acceptance criteria you will meet before you start, and ask with ask_question if the expected behaviour is unclear.",
      "Follow the existing architecture and patterns; reuse components and helpers instead of adding parallel ones.",
      "Cover the new behaviour with tests (happy path, edge cases, errors) and update docs or types other code depends on.",
      "Keep the change scoped to the feature; note follow-ups instead of doing them.",
    ],
    review: ["Every acceptance criterion is met", "New behaviour has tests, including edge cases and error paths", "No unrelated changes or half-finished code paths"],
    keywords: ["feature", "build", "implement", "product"],
  },
  {
    type: "bug",
    label: "Bug fix",
    description: "Something is broken or behaves wrongly.",
    guidance: [
      "Reproduce the bug first: find or write a failing test (or a script) that shows it, before changing code.",
      "Find the root cause; do not patch the symptom. Explain the cause in your summary.",
      "Make the smallest fix that addresses the cause, then make the failing test pass and keep it as a regression test.",
      "Look for the same mistake elsewhere in the code and mention any other places it occurs.",
    ],
    review: ["The root cause is fixed, not just the symptom", "A regression test fails without the fix and passes with it", "The fix is minimal and does not change unrelated behaviour"],
    keywords: ["bug", "debug", "fix", "error", "regression", "troubleshoot"],
  },
  {
    type: "improvement",
    label: "Improvement",
    description: "Make something that works better: faster, clearer, nicer.",
    guidance: [
      "Measure or describe the current behaviour first so the improvement can be shown (timings, screenshots, sizes, UX steps).",
      "Keep existing behaviour and public interfaces unless the task asks to change them.",
      "Show the before and after in your summary.",
    ],
    review: ["The improvement is real and shown (before/after)", "Existing behaviour and interfaces are unchanged unless requested", "No regressions in tests"],
    keywords: ["improve", "performance", "optimi", "polish", "ux"],
  },
  {
    type: "refactor",
    label: "Refactor",
    description: "Restructure code without changing what it does.",
    guidance: [
      "Behaviour must not change. Run the tests before you start and after every step; add tests first where coverage is missing.",
      "Change structure in small, reviewable steps; do not mix in features or fixes.",
    ],
    review: ["No behaviour change (tests unchanged and passing)", "The structure is clearly better", "No mixed-in features or fixes"],
    keywords: ["refactor", "clean", "structure", "simplif"],
  },
  {
    type: "design",
    label: "Design / UI",
    description: "Visual design, layout, styling or UX work.",
    guidance: [
      "Follow the project's design system and existing screens; reuse its components and tokens.",
      "Handle loading, empty, error, mobile and dark-mode states.",
      "Check the result in the running preview before you finish and describe what you checked.",
    ],
    review: ["Consistent with the design system (tokens, components, spacing)", "All states handled: loading, empty, error, mobile, dark mode", "Accessible: labels, focus, contrast"],
    keywords: ["design", "ui", "frontend", "style", "css", "accessib", "shadcn"],
  },
  {
    type: "docs",
    label: "Docs",
    description: "Documentation, READMEs, guides or comments.",
    guidance: ["Check every command and code sample you document actually works.", "Write for the reader who does not know the code; keep it short and current."],
    review: ["Accurate: commands and samples work", "Clear for a newcomer", "No code changes beyond what the docs need"],
    keywords: ["doc", "readme", "writing", "copy"],
  },
  {
    type: "test",
    label: "Tests",
    description: "Add or fix tests.",
    guidance: ["Test behaviour, not implementation details.", "Make each new test fail first to prove it checks something.", "Keep tests fast and deterministic."],
    review: ["Tests check real behaviour and would catch regressions", "No flaky timing or order dependence", "Production code unchanged unless needed"],
    keywords: ["test", "e2e", "playwright", "vitest", "jest"],
  },
  {
    type: "chore",
    label: "Chore",
    description: "Dependencies, config, CI, tooling.",
    guidance: ["Read release notes for any upgraded dependency and fix breaking changes.", "Run the full checks; keep the change mechanical and easy to review."],
    review: ["Builds and checks pass", "Breaking changes from upgrades are handled", "Nothing unrelated changed"],
    keywords: ["dependenc", "upgrade", "ci", "config", "tooling", "migration"],
  },
  {
    type: "review",
    label: "Review & continue",
    description: "Pick up work another agent or person started on a branch: check it, then finish it.",
    guidance: [
      "Before changing anything, read what was already done: `git log` and `git diff` against the base branch, and run the checks. Do not assume the earlier work is correct or complete.",
      "Compare it with the task text and list what is done, what is missing and what is wrong. Put that list in your summary.",
      "Keep the earlier work where it is correct; fix what is wrong and finish what is missing instead of starting over. Ask with ask_question before rewriting or removing large parts of it.",
      "Remove leftovers such as debug output, commented-out code and TODOs the earlier agent left behind.",
    ],
    review: ["Everything the task asks for is done, including what the earlier work left out", "Mistakes in the earlier work are fixed, not carried over", "Correct earlier work was kept rather than rewritten"],
    keywords: ["review", "continue", "handoff", "takeover", "finish"],
  },
];

export const taskTypeInfo = (type: TaskType | null | undefined) => TASK_TYPES.find((t) => t.type === type) ?? null;

export const isTaskType = (value: unknown): value is TaskType => TASK_TYPES.some((t) => t.type === value);
