

## 2026-11-13: Recompute PR spelling check blocked CI

- Symptoms and impact: [PR #3301](https://github.com/Asherlc/dofek/pull/3301) remained unmergeable because its spelling check failed; no production impact was observed.
- Evidence: [CI run 43465301919](https://github.com/Asherlc/dofek/actions/runs/43465301919) failed `Test / Spell Check` with `RecomputeActivityButton.test.tsx:97:66 - Unknown word (Recomput)`. Lint, test, and CI aggregate gates propagated that failure; the actual lint, typecheck, unit, mobile, integration, and mutation jobs succeeded.
- Root cause and fix: the button selector used a truncated word in `/^Recomput/`. It now explicitly matches both complete button-state words with `/^Recompute|^Recomputing/`; dictionaries and CI gates are unchanged.
- Validation and remaining risk: the corrected test file passes CSpell with zero issues and Biome formatting, and the selector matches both idle and busy labels. Final matching-head CI is required before merge; no retry, timeout, or other resilience change was introduced.
