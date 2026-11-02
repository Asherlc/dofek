# Vertical ascent activity links

Approved direction: carry activity IDs through the ascent response and open activity details from bubbles and accessible chart data on web and mobile. Reuse existing navigation and disclosure controls; preserve chart metrics and styling.

Execution: superpowers:executing-plans, in the existing worktree.

- [x] Add failing API identity and chart navigation tests.
- [x] Project activity_id through the repository, model, and response schemas; update fixtures and caches.
- [x] Wire web bubble clicks and disclosure links; wire mobile bubble presses and accessible rows.
- [x] Run focused tests, database regression, typechecks and lint; review the diff, commit and push.

Review checkpoints: regression tests failed before implementation; 225 focused tests pass, plus all 40 mobile-dashboard router tests after updating cache expectations. Web/server/mobile typechecks, changed-file Biome checks, diff review and Safari bubble/disclosure checks pass. Independent review found missing Storybook router context; corrected and visually verified. Local database integration was initially blocked by Redpanda host async-I/O capacity; see the incident baseline. [CI run 41388360507](https://github.com/Asherlc/dofek/actions/runs/41388360507) subsequently passed the corrected canonical-group-ID regression and all four integration shards, including 728 tests in the formerly failing shard. The full workflow passed on 5d4691d.
