---
name: accessible-ui
description: Make interfaces usable with a keyboard, screen readers and zoom, and meet WCAG 2.2 AA. Use whenever you build or change forms, dialogs, menus, navigation, tables, custom controls, or anything interactive in a web or mobile UI.
task-types: [design]
---

# Accessible UI

Treat accessibility as part of "done", not a follow-up. Check each item below for the parts of the UI you touched.

## Structure

- Use the right element first: `<button>` for actions, `<a href>` for navigation, `<label>` for inputs, `<table>` for tabular data, headings in order (`h1` → `h2` → `h3`), landmarks (`header`, `nav`, `main`, `footer`).
- One `h1` per page. Every page or route sets a meaningful document title.
- Only reach for ARIA when no native element fits; a wrong role is worse than none.

## Keyboard

- Everything clickable is reachable with Tab and works with Enter/Space. No `div` with only an `onClick`.
- Focus order follows the visual order. Focus is always visible (never `outline: none` without a replacement).
- Dialogs and sheets trap focus while open, close with Escape, and return focus to the control that opened them.
- Menus, tabs, listboxes and comboboxes follow the WAI-ARIA Authoring Practices keyboard patterns. Prefer the project's Radix/shadcn/Headless UI components, which already do this.

## Names, states and messages

- Every control has an accessible name: visible label, `aria-label` for icon-only buttons, `alt` for meaningful images (`alt=""` for decorative ones).
- Form errors are linked to their field (`aria-describedby`), announced, and say how to fix the problem. Required fields are marked in text, not only with colour.
- Expanded/collapsed, selected, pressed and busy states are exposed (`aria-expanded`, `aria-selected`, `aria-pressed`, `aria-busy`).
- Toasts and async status updates use a polite live region; errors that block the user use an assertive one.

## Visual

- Text contrast at least 4.5:1 (3:1 for large text and UI component boundaries) in every theme.
- Never use colour alone to convey meaning; add text or an icon.
- Layout works at 200% zoom and 320 px width without horizontal scrolling. Respect `prefers-reduced-motion`.
- Touch targets at least 24×24 CSS px (aim for 44×44 on mobile).

## Mobile (React Native / Expo)

- Set `accessibilityLabel`, `accessibilityRole` and `accessibilityState` on custom touchables.
- Support Dynamic Type / font scaling; do not fix heights that clip larger text.

## Verify

- Tab through the changed screen yourself (or with a Playwright test using `page.keyboard`).
- If the project has `@axe-core/playwright`, `jest-axe` or `eslint-plugin-jsx-a11y`, run them and fix what they report.
- Mention in your summary what you checked and anything you could not verify.
