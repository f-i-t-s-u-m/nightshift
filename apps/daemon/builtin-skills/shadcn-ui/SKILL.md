---
name: shadcn-ui
description: Work correctly in projects that use shadcn/ui with Tailwind CSS (a components.json file or a components/ui folder of Radix-based components). Use when adding or changing UI in such a project, adding a shadcn component, theming, or fixing dark mode.
task-types: [design]
---

# shadcn/ui projects

shadcn/ui components are source files the project owns (usually `components/ui/*.tsx`), built on Radix primitives and Tailwind. Treat them as the design system.

## Before you change anything

1. Read `components.json` for the style, the base colour, the CSS variables file, the aliases (`@/components`, `@/lib/utils`) and the icon library.
2. Read the CSS file it points to (`globals.css` / `index.css`): the theme lives in CSS variables such as `--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--ring`, with a `.dark` block. Tailwind v4 projects map them with `@theme inline`.
3. List `components/ui` to see which components already exist.

## Rules

- Compose existing components (`Button`, `Card`, `Dialog`, `Sheet`, `DropdownMenu`, `Select`, `Tabs`, `Table`, `Badge`, `Skeleton`, `Tooltip`, `Sonner`/toast, `Form`) instead of hand-rolling markup.
- Need a component that is missing? Add it with the CLI the project uses (`npx shadcn@latest add <name>` / `bunx --bun shadcn@latest add <name>`) if network access works; otherwise write it following the same pattern as the existing files. Never install a second component library for one widget.
- Style with semantic tokens: `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-card`, `border-border`, `bg-primary text-primary-foreground`, `ring-ring`, `bg-destructive`. Never hard-code colours like `bg-white`, `text-gray-500` or hex values; they break dark mode and theming.
- Use variants, not overrides: `<Button variant="outline" size="sm">`. If the same override appears in three places, add a variant with `cva` in the component file.
- Merge classes with `cn()` from `@/lib/utils` so callers can extend styles.
- Keep Radix behaviour intact: use `asChild` to render links as buttons; keep `DialogTitle`/`DialogDescription` (visually hidden if needed) for accessibility.
- Forms: `react-hook-form` + `zod` with the `Form` components when the project already uses them.
- Icons from the configured library (usually `lucide-react`), sized with `size-4` / `size-5`.

## Theming changes

- Change colours by editing the CSS variables for both `:root` and `.dark`, keeping foreground/background pairs readable.
- Radius comes from `--radius`; do not mix arbitrary `rounded-[…]` values.

## Check

Run typecheck and lint, open the page in light and dark mode (via the `preview` tool or the dev server), and confirm no hard-coded colours slipped in: `grep -rnE "(bg|text|border)-(white|black|gray|slate|zinc)-?[0-9]*" <changed files>`.
