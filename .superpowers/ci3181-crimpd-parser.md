# PR 3181: Crimpd parser mutation coverage

## Scope and diagnosis

Only `src/providers/crimpd/parser.test.ts` changed. The existing four tests passed while CI's parser range scored 42.08% (85 killed, 97 survived, 20 uncovered): assertions did not distinguish raw field mappings, conversion arithmetic, validation boundaries, individual climbing signals, or optional observation fields. No production parser behavior or public exports were changed.

## Verification

- `rtk proxy pnpm exec vitest run src/providers/crimpd/parser.test.ts --project unit`: 62 passed.
- `rtk proxy pnpm exec biome check --write src/providers/crimpd/parser.test.ts`: passed.
- `rtk proxy pnpm exec tsc --noEmit --pretty false`: no errors in this file; concurrent archive and MoonBoard test edits produced errors (reported to their owners).
- First successful mutation run: 93.56%, 189 killed, 13 survived, no uncovered mutants/timeouts/errors. This exposed two remaining real gaps: invalid ISO dates ending in `Z`, and orphan checks whose broad `/workout/` assertion accepted a downstream date-validation error. Both assertions were strengthened. Five static header/mapping mutants were selected only against registration/startup tests; an isolated dynamic-import parser contract test now exercises their initialization through the public parser.
- Final mutation verification: **97.52%, 197 killed, 5 survived, 0 uncovered, 0 timeouts, 0 errors**, exit 0. All five survivors are equivalent null checks proved below. Initial related-test dry run passed 333 tests. Baseline configuration remains `stryker.ci.config.json`, mutation range `src/providers/crimpd/parser.ts:1-256`, `incremental: false`, concurrency 2, unchanged thresholds and timeouts. JSON report: `/tmp/pr3181-crimpd-parser-mutation.json`; full log: `/tmp/pr3181-crimpd-parser-stryker.log`.

The Stryker CLI rejects `--jsonReporter.fileName`. The equivalent core API preserves every CI setting and overrides only mutation range and output/sandbox locations:

```sh
rtk proxy node --input-type=module -e 'import { Stryker } from "@stryker-mutator/core"; await new Stryker({configFile:"stryker.ci.config.json", mutate:["src/providers/crimpd/parser.ts:1-256"], jsonReporter:{fileName:"/tmp/pr3181-crimpd-parser-mutation.json"}, tempDirName:".stryker-tmp/ci3181-crimpd-parser"}).runMutationTest();' > /tmp/pr3181-crimpd-parser-stryker.log 2>&1
```

For future verification, serialize runs with the default `.stryker-tmp` directory. During this investigation external `/tmp` sandboxing failed related-test discovery in this workspace, whereas repository sandboxing succeeded. Concurrent custom sandbox directories increased discovered files (12,544 → 25,092 → 37,641); serialize final verification to avoid copying sibling run artifacts. No repository configuration was changed to accommodate these local attempts.

## Review checkpoint and retrospective

The new tests exercise the public `parseCrimpdExport` entrypoint and reuse existing CSV fixtures without shared-file changes. They assert raw field fidelity; centimeter/inch conversions; integer/decimal/int32 representation; source identities across workouts/exercises; all grade, location, board and hold mappings; completion and rope methods; angle boundaries; and invalid source rows. Direct mutation evidence made the missing branches clear. For the next similar CI repair, use the `write-tests` skill and record the default ignored sandbox prefix plus core-API JSON-report override in the mutation runbook.

## Equivalent null-check mutants

All five depend on existing JavaScript coercion or type predicates; production guards were retained for readable intent:

- ID 78: removing `position === null` leaves `position < 1`; `null < 1` is true, so missing positions still throw. All non-null values have the identical comparison.
- ID 177: replacing `reps !== null` with true in the negative check leaves `reps < 0`; `null < 0` is false, so absent repetitions still pass validation.
- ID 198: removing the strength-set null check leaves `Number.isInteger(reps)`; that predicate returns false for null, so the stored repetition count is still null.
- ID 237: removing the angle null check still leaves `angle < -90 || angle > 90`; both comparisons are false for null, so absent angles remain valid and are omitted downstream.
- ID 288: removing the attempt-count null check leaves `reps > 0`; `null > 0` is false, so no attempt count is invented for absent repetitions.
