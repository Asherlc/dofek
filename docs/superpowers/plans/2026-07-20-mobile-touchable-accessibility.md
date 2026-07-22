# Mobile touchable accessibility implementation plan

## Problem

Primary React Native actions are absent from the iOS accessibility hierarchy in a signed Release build. Native navigation controls and text inputs remain discoverable, but users and accessibility automation cannot focus or activate core actions including Sign In, onboarding navigation, Settings cards, provider Sync/Connect actions, and support submission.

React Native documents that touchable elements should be accessible by default and that `accessibilityRole` communicates their purpose to assistive technology: [React Native Accessibility](https://reactnative.dev/docs/accessibility).

## Evidence

- Reproduced with repeated native accessibility snapshots from a signed Release build on an iPhone 17 Pro simulator.
- Login exposed its text fields but no Sign In or Create Account action.
- Onboarding exposed its instructional text but no action buttons.
- Settings exposed input fields and static card text but no tappable cards or action buttons.
- Data Sources and provider detail exposed provider names and statuses but no Sync, Full Sync, Connect, Import, or primary provider action.
- Support exposed all three text fields but no Submit action.
- Native Back buttons and Expo tab-bar buttons were exposed as buttons throughout the same session, which rules out a globally broken accessibility snapshot.
- The affected implementation sites use React Native `TouchableOpacity` without explicit accessible names, button/link roles, or state metadata.

## Implementation

1. Add focused component tests across login, onboarding, settings, provider list/detail, and support that query primary actions by accessible role and name, assert disabled/busy state metadata, verify nested text does not replace the touch target's semantics, and activate each action to prove its callback/navigation still runs.
2. Give every affected touch target an explicit semantic role, accessible label, and applicable disabled/busy state; ensure nested text does not replace or hide the actionable element.
3. Prefer shared button/card components where they already exist, but do not introduce a new abstraction solely for this fix.
4. Audit the remaining mobile `TouchableOpacity` and `Pressable` call sites so equivalent core actions are not left unreachable.
5. Update affected Storybook stories and their accessibility assertions.

## Acceptance criteria

- VoiceOver can focus, identify, and activate every core action on login, onboarding, Settings, Data Sources, provider detail, and support screens.
- Native accessibility snapshots expose each action as a tappable button or link with a meaningful name.
- Disabled and loading actions announce their state.
- Visible text, layout, and ordinary touch behavior remain unchanged.

## Validation

- Run the focused mobile component tests using role-and-name queries.
- Build and install a signed Release simulator artifact.
- Re-run native accessibility snapshots and activate each representative action through the accessibility hierarchy.
- Perform a short VoiceOver pass on the same screens.
