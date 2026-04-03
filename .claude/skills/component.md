---
description: Use when writing or modifying React components in packages/web or packages/mobile.
---

# React Component Development

When creating or modifying React components, you MUST write or update Storybook stories to illustrate your changes.

## Web (`packages/web`)

- Stories live next to the component: `ComponentName.stories.tsx`
- Use `@storybook/react-vite` imports
- Follow the existing pattern (see `packages/web/src/components/*.stories.tsx` for examples):
  ```tsx
  import type { Meta, StoryObj } from "@storybook/react-vite";
  ```
- Include a `Default` story plus stories for key states (loading, empty, error, edge cases)
- Use `tags: ["autodocs"]` for automatic documentation
- Run `pnpm storybook` to verify your stories render correctly

## Mobile (`packages/mobile`)

- Stories live next to the component: `ComponentName.stories.tsx`
- Use `@storybook/react-native` imports
- Run `pnpm storybook:mobile` to verify on-device

## Checklist

Before finishing component work:

1. [ ] Story file exists for the component (`ComponentName.stories.tsx`)
2. [ ] Default story shows the standard/happy-path rendering
3. [ ] Key variant stories cover loading, empty, and error states where applicable
4. [ ] Stories use realistic mock data (not lorem ipsum or placeholder values)
5. [ ] Stories render without console errors in Storybook
