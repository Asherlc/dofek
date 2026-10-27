# Web System Dark Appearance TDD Plan

**Goal:** Make the web application follow the operating system's light or dark appearance without adding a separate preference or duplicating theme state.

**Behavior:** When `prefers-color-scheme: dark` matches, public, authentication, and authenticated web surfaces use an accessible dark semantic palette; when it does not match, the existing light appearance remains unchanged.

**Scope:** Web only. The separately active iOS issue #2191 owns mobile appearance. Brand marks and data-series colors stay stable unless browser contrast evidence shows that a foreground color is unreadable.

**References:**

- [`prefers-color-scheme`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme) exposes the user's system appearance preference to CSS.
- [`color-scheme`](https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme) lets browser-provided controls and canvas surfaces use supported schemes.
- [WCAG 2.2 contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) requires at least 4.5:1 for normal text and 3:1 for large text.

## Current Evidence

- Cypress running Chrome 150 with an emulated dark system preference reports that `matchMedia("(prefers-color-scheme: dark)")` matches.
- The same runtime still computes the login page background from the fixed light token `#eef3ed` and the login panel from `#f5f9f5`.
- `packages/web/src/index.css` defines only light values for the existing semantic utilities and repeats light literals in body, card, hero, animation, and skeleton styles.
- A limited set of major screens and shared status cards bypass the tokens with `bg-white`, slate utilities, or light-only landing-page hex values.

## Test Strategy

- Browser: emulate the dark system preference through Chrome DevTools Protocol, visit the public landing and login routes with network boundaries stubbed, and assert actual computed colors and declared scheme.
- Component/Storybook: render the existing full-screen `PageLayout` story with the same emulated browser preference and audit the representative shell, cards, text, navigation, and controls.
- Static verification: build the web application and Storybook, run the Storybook accessibility test suite, and use a contrast calculator against each semantic foreground/background pair.
- Parity: no mobile files change because #2191 is already implementing that platform.

## File Structure

- Create: `cypress/e2e/dark-mode.cy.ts` — browser-level system-appearance regression.
- Modify: `packages/web/src/index.css` — canonical light and dark semantic tokens plus token-backed global utilities.
- Modify: `packages/web/src/pages/LandingPage.tsx` — replace light-only presentation literals with semantic utilities.
- Modify: selected shared web components that still hard-code light surfaces — make major authenticated/status surfaces consume the canonical tokens.
- Modify: `packages/web/src/components/PageLayout.stories.tsx` — retain a representative full-screen appearance/a11y scenario.
- Modify: `cypress/README.md` — include the new appearance regression in the E2E inventory.

## Tasks

### Task 1: Add the Failing Browser Regression

- [x] Add dark-system tests for the landing and login routes, including computed page, surface, text, and browser `color-scheme` assertions.
- [x] Run Cypress against the local web application with the browser preference emulated through Chrome DevTools Protocol.
- [x] Confirm failure because the current computed page and surface colors are the light palette even though the browser reports a matching dark preference.

### Task 2: Implement Canonical Semantic Theme Tokens

- [x] Add the smallest dark override for the existing semantic tokens under `prefers-color-scheme: dark`.
- [x] Back body, cards, dashboard hero, hover shadows, loading shimmer, and form controls with those tokens.
- [x] Preserve the light appearance while improving the existing subtle-text token to meet WCAG AA.
- [x] Run the focused Cypress regression and confirm the global/login assertions pass.

### Task 3: Migrate Major Screens That Bypass Tokens

- [x] Replace light-only arbitrary colors on the landing page with semantic page, surface, border, foreground, muted, subtle, accent, and inverse text utilities.
- [x] Replace remaining light-only shared dashboard/status card surfaces in the touched visual path.
- [x] Preserve intentional provider brand and chart-series colors.
- [x] Run the affected component tests and the full Docker-free test suite.

### Task 4: Verify Storybook and Accessibility

- [x] Extend the full-screen `PageLayout` story so the major shell and control states are represented together.
- [x] Run Storybook under an emulated dark preference and inspect a representative screenshot.
- [x] Run `pnpm storybook:web:build`.
- [x] Run `pnpm lint`.
- [x] Verify semantic text/background pairs meet WCAG AA contrast.

### Task 5: Final Validation and Delivery

- [x] Run `pnpm typecheck`.
- [x] Run `pnpm --dir packages/web typecheck`.
- [x] Run `pnpm test`.
- [x] Run the focused Cypress regression against the local web application; the isolated E2E stack remains reserved by another active worktree on its fixed host port.
- [ ] Push the linked branch, open a PR with `Fixes #2186`, link it from the issue, and monitor all checks and review feedback through merge.
