# Climbing area lineage

The user approved option B with the complete area lineage on one line, then requested implementation and a PR.

## Intent and scope

Show the location of grouped climbing logs without repeating it in every card. Replace the immediate-area heading with the entire recorded root-to-leaf area path, separated by `›`, with the final area emphasized. Apply this to attached and unattached groups in both web and mobile activity panels and the existing grouped breakdowns.

Keep the breadcrumb on one line. Long paths scroll horizontally without truncation; web users can focus and scroll a named region containing the heading with a keyboard. Preserve the complete accessible heading text and identify it as an area. Use stock [CSS horizontal overflow](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow-x) with [named, focusable scroll regions](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow#accessibility) and React Native's [horizontal ScrollView](https://reactnative.dev/docs/scrollview#horizontal).

Keep existing grouping, ordering, source links, cards, selection, attachment, and missing-area presentation. Use the recorded lineage as supplied; do not invent missing parents or change the API, storage, dependencies, or route identities.

## Approaches

- A: Prefix the existing leaf heading with “Area.” Smallest change, but lacks parent context.
- B (approved): Show the complete lineage once per existing group. Keep the current area bold and horizontal overflow scrollable.
- C: Add a separate location grouping level. More visual structure than the user selected.

## Implementation decisions

Expose the first entry's recorded `areaPath` in the existing grouping result. The four current list consumers render that path directly with platform-native text and scrolling. No new component or formatting framework is needed. This follows the repository's minimum-code preference and [Google's review guidance on complexity](https://google.github.io/eng-practices/review/reviewer/looking-for.html#complexity).

The user approved disabling only Biome's `noNoninteractiveTabindex` rule in the two web list files. This permits the real keyboard-focusable scroll sections recommended by [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow#accessibility), while retaining every other lint rule. Biome's [rule documentation](https://biomejs.dev/linter/rules/no-noninteractive-tabindex/javascript/) describes its general restriction on focusable noninteractive elements.

## Acceptance

Tests cover complete paths, leaf-only and missing paths, attached and unattached groups, and preservation of existing grouping/selection behavior. Existing stories demonstrate real names and a long path at narrow widths. Review the actual diff and check lint, TypeScript, unit/mobile tests, and PR CI before declaring the PR ready.
