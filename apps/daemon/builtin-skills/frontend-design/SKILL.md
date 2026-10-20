---
name: frontend-design
description: Build or restyle web pages, screens and components so they look deliberate, polished and production-ready instead of generic. Use for any task that creates UI, changes how something looks, or mentions design, layout, styling, landing pages, dashboards or "make it look better".
task-types: [design, feature]
---

# Frontend design

Your goal is UI a careful product designer would sign off on: a clear hierarchy, consistent spacing, real content, every state handled, and one coherent visual direction. Generic output (centered card on a grey page, default blue buttons, emoji icons, lorem ipsum, everything the same size) counts as a failed task even if it works.

## 1. Read before you draw

1. Find the project's existing design language before adding anything:
   - Tailwind config / CSS variables / theme files (`tailwind.config.*`, `globals.css`, `index.css`, `theme.ts`, `tokens.*`).
   - The component library in use (shadcn/ui in `components/ui`, MUI, Chakra, Radix, a local design system package in a monorepo).
   - Two or three existing screens similar to the one you are building. Match them.
2. If the repository has a design document, brand guide, Figma export or screenshots attached to the task, they win over everything in this skill.
3. Reuse existing components and tokens. Do not add a second button style, a new colour, or a new font when the project already has one.

## 2. Decide the direction (only when nothing exists yet)

Write down, in your head or in the plan, three choices and keep them for the whole task:

- **Tone**: for example calm and editorial, dense and technical, warm and friendly, bold and playful. Pick one that fits the product and its users.
- **Type**: one typeface for the UI (a good system stack or one well-chosen web font) plus at most one display face for headings. Use a type scale (e.g. 12 / 14 / 16 / 20 / 24 / 32 / 48) and stick to it.
- **Colour**: one neutral ramp for surfaces and text, one accent used sparingly for primary actions and focus, and semantic colours for success / warning / danger. Define them as tokens (CSS variables or theme entries), with dark mode if the project supports it.

## 3. Layout and spacing

- Use a 4 px (or the project's) spacing scale. No arbitrary values like `13px` or `mt-[7px]`.
- Group related things and separate unrelated ones: spacing inside a group is smaller than spacing between groups.
- Give content a sensible max width (text lines 60–80 characters; forms 400–640 px; dashboards use a grid).
- Align to a grid. Left-align text and forms; centre only short hero content.
- Hierarchy comes from size, weight and colour together: one primary action per view, secondary actions visually quieter, destructive actions clearly separated.
- Design mobile first and check 375 px, 768 px and 1280 px widths. Nothing may scroll sideways on a phone; touch targets at least 40×40 px.

## 4. Details that separate polished from generic

- Real, plausible content: realistic names, numbers, dates and copy. Never lorem ipsum in the final result.
- Every data view handles **loading** (skeletons that match the final layout), **empty** (what it is, why it is empty, the next action), **error** (what happened, how to retry) and **long content** (truncation with a tooltip, wrapping, overflow).
- Interactive elements have hover, focus-visible, active and disabled styles. Focus rings must be visible.
- Use an icon set already in the project (e.g. lucide). Same size and stroke everywhere. No emoji as icons.
- Borders, radii and shadows come from one small set. Prefer subtle borders and a single elevation level over heavy shadows.
- Numbers in tables are right-aligned and use tabular figures; dates and currency are formatted for the user's locale.
- Motion is short (150–250 ms), eases out, and never blocks input. Respect `prefers-reduced-motion`.
- Contrast: body text at least 4.5:1, large text and icons at least 3:1, in light and dark mode.

## 5. Copy

- Buttons say what they do ("Save changes", "Invite member"), not "Submit" or "OK".
- Sentence case for labels and headings. Short helper text under fields that need it; errors say how to fix the problem.

## 6. Check your work before you finish

1. Run the app or use the `preview` tool, and fetch the page you changed to make sure it renders without errors.
2. If the project has Playwright or another browser test tool, take screenshots at phone and desktop width and look at them. Fix anything misaligned, cramped, overflowing or inconsistent.
3. Run the project's lint, typecheck and tests.
4. In your summary, describe the visual direction you followed and list the states you covered (loading, empty, error, mobile, dark mode).
