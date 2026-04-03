---
description: Use when writing or modifying React components in packages/web or packages/mobile.
---

# React Component Development

When creating or modifying React components, you MUST write or update both **tests** and **Storybook stories** to cover your changes.

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

## Tests

- Test files live next to the component: `ComponentName.test.tsx`
- Mock ECharts with `vi.mock("echarts-for-react", ...)` to capture the option object for assertion
- Mock `LoadingSkeleton.tsx` to render a simple `data-testid` div
- Test all states: default rendering, loading, empty, and any behavioral logic (e.g., axis rounding, color thresholds, conditional rendering)
- When fixing a bug, write a failing test that reproduces the bug before writing the fix

## Checklist

Before finishing component work:

1. [ ] Test file exists for the component (`ComponentName.test.tsx`)
2. [ ] Tests cover default rendering, loading, empty, and error states
3. [ ] Tests verify any non-trivial logic (axis functions, color rules, conditional display)
4. [ ] Story file exists for the component (`ComponentName.stories.tsx`)
5. [ ] Default story shows the standard/happy-path rendering
6. [ ] Key variant stories cover loading, empty, and error states where applicable
7. [ ] Stories use realistic mock data (not lorem ipsum or placeholder values)
8. [ ] Stories render without console errors in Storybook
