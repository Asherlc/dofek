# Password Form Guidance TDD Plan

Issue: [#2098](https://github.com/Asherlc/dofek/issues/2098)

## Scope

PR [#2337](https://github.com/Asherlc/dofek/pull/2337) established the
canonical 8–128 character policy in `@dofek/auth` and completed login and
registration guidance. This follow-up completes the remaining Dofek account
password forms:

- web login, reset, and settings Caps Lock status;
- web reset and settings password visibility, shared requirements, and
  pre-submit validation;
- mobile settings password visibility, shared requirements, pre-submit
  validation, and password-manager metadata.

Provider-source credential forms remain outside this account-password scope
because their policies are owned by their providers.

## Platform Contract

- Web Caps Lock status uses
  [`KeyboardEvent.getModifierState("CapsLock")`](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/getModifierState).
- Web password fields retain `current-password` and `new-password`
  autocomplete tokens as defined by the
  [HTML autocomplete specification](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill).
- React Native settings fields use the documented cross-platform
  `current-password` and `new-password` autocomplete values and iOS
  [`passwordRules`](https://reactnative.dev/docs/textinput#passwordrules).
- Native Caps Lock status is excluded because React Native `TextInput` does
  not expose keyboard modifier-lock state.

## TDD Sequence

1. Add failing web tests proving:
   - Caps Lock status appears and clears on password keyboard events;
   - reset and settings fields reveal and hide independently;
   - shared requirements and 8–128 boundaries are rendered and enforced;
   - reset and settings mutations are not called for invalid passwords.
2. Add failing mobile settings tests proving:
   - each password field has an accessible reveal control;
   - new-password requirements and native metadata are present;
   - invalid new passwords do not reach the mutation.
3. Implement the minimum production changes using the existing shared
   `@dofek/auth` constants and validator.
4. Update existing web password-settings and mobile settings stories for the
   completed form states.
5. Run focused unit/mobile tests, package typechecks, Storybook production
   builds, repository lint/test gates, and exact-head hosted CI.
