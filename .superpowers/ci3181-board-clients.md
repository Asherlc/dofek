# PR 3181 board-client mutation coverage

Scope: only `src/lib/aurora-board-client.test.ts` and `src/lib/kilter-board-client.test.ts`; no production changes, configuration changes, ignores, or test-only exports.

Baseline CI ranges and scores:

- `src/lib/aurora-board-client.ts:1-206`: 66.67%, 65 survived, 3 uncovered.
- `src/lib/kilter-board-client.ts:1-203`: 64.90%, 48 survived, 5 uncovered.

Added public-interface cases for transport headers, abort signals, login errors, session validation, token refresh/expiry/account preservation/persistence failures, tombstones, cursor ownership and completeness, optional fact mapping, impossible angles, UTC dates, and known/unknown grades.

Verification:

```sh
rtk pnpm exec vitest run --project unit src/lib/aurora-board-client.test.ts src/lib/kilter-board-client.test.ts
rtk pnpm exec biome check --write src/lib/aurora-board-client.test.ts src/lib/kilter-board-client.test.ts
rtk git diff --check
```

Both final test files passed: 86 tests (46 Aurora, 40 Kilter), including fresh dynamic-import cases exercising schema initialization during public-client behavior and rejecting malformed grade/rating records. Biome formatted both files; diff whitespace check passed.

Exact CI mutation verification, overriding only changed mutation ranges and generated output paths:

```sh
rtk proxy sh -c 'pnpm exec node --input-type=module -e '\''import { Stryker } from "@stryker-mutator/core"; await new Stryker({configFile:"stryker.ci.config.json",mutate:["src/lib/aurora-board-client.ts:1-206","src/lib/kilter-board-client.ts:1-203"],tempDirName:".stryker-tmp/board-clients",jsonReporter:{fileName:"/tmp/pr3181-board-clients-mutation.json"}}).runMutationTest();'\'' > /tmp/pr3181-board-clients-stryker.log 2>&1'
```

No concurrency, timeout, threshold, testFiles, related, exclusion, or Vitest-config overrides. An absolute `/tmp` sandbox failed initial related-test discovery with `Vitest failed to find test files related to mutated files` / `No tests were executed`; it was removed rather than weakening related-test discovery. See [Stryker's related-test troubleshooting](https://stryker-mutator.io/docs/stryker-js/troubleshooting/#vitest-failed-to-find-test-files-related-to-mutated-files).

First complete exact CI-range run (75-test version): initial run passed 360 related tests, then mutation verification passed the existing 75 threshold:

| File | Score | Killed | Timeout | Survived | Uncovered |
| --- | --- | --- | --- | --- | --- |
| Aurora | 88.24% | 179 | 1 | 24 | 0 |
| Kilter | 88.08% | 133 | 0 | 18 | 0 |
| Combined | 88.17% | 312 | 1 | 42 | 0 |

Evidence: `/tmp/pr3181-board-clients-mutation.json` and `/tmp/pr3181-board-clients-stryker.log`. The timeout is the mutated infinite pagination counter (`pageNumber--`), correctly detected by CI's unchanged timeout.

Added seven further behavioral cases after inspecting that report: structured authentication failure metadata, bids with false listing flags, eager malformed-record/date rejection before later tombstones, repeated cursor rejection after an initial advance, distinct Kilter log identities, and matching ratings without comments. Also tightened omitted attempt facts with strict equality.

Final exact-range attempt used the same command with `tempDirName:".stryker-tmp/board-clients-final"`, report `/tmp/pr3181-board-clients-mutation-final.json`, and log `/tmp/pr3181-board-clients-stryker-final.log`. It failed during sandbox copying, before final mutation verification: `ENOENT: no such file or directory, copyfile` for `.stryker-tmp/ci3181-crimpd-parser/sandbox-eNLKcS/packages/mountain-project-client/tsconfig.json`, copied into the board-client sandbox. ProjectReader counted 75,284 files rather than the first run's 12,544. This proves nested custom tempDirName excludes its own subtree but can copy sibling sandboxes; one sibling completed and removed its files during copying. Root will perform serialized final mutation verification. No additional runs or cleanup were performed after coordination.

Survivor classification from the first complete report:

- Static schema survivors (Aurora IDs 1–10, Kilter IDs 255–265) are **not equivalent**. The report marks `static:true` and assigns only nine provider-registration/worker tests to these mutants, excluding the client tests that exercise parsing and impossible angles. Do not remove or weaken schema validation to address this runner selection artifact.
- Genuine equivalent dynamic mutations: Aurora ID 15 removes the regex end anchor but downstream ISO parsing still rejects malformed timestamps; ID 19 requires a timezone colon, which downstream ISO parsing already requires. IDs 145/150/152 replace empty fallback arrays with strings: absent attempt fields create only an unreachable undefined-key entry, and unknown cursor tables are skipped. ID 195 looks up a nullish attempt ID in a number-keyed map, still returning undefined. ID 221 removes the null check before `bid_count > 0`, which already excludes null/undefined. Kilter ID 378 removes the angle null check, but a required numeric rating angle cannot equal nullish log angle. ID 416 looks up nullish difficulty in a number-keyed map, still yielding no grade. ID 421 removes a null check before `attempts > 0`, which already excludes null/undefined.
- Other survivors motivated the final added tests or stronger omission assertions; their final status requires root's serialized run. No equivalent-mutant exclusions were added.

Root's final serialized run with the exact CI config and default `.stryker-tmp` directory passed. Evidence: `/tmp/pr3181-final-clients-ui-mutation.json`.

| File | Score | Killed | Timeout | Survived | Uncovered |
| --- | --- | --- | --- | --- | --- |
| Aurora | 96.57% | 196 | 1 | 7 | 0 |
| Kilter | 96.69% | 146 | 0 | 5 | 0 |

Final survivors (IDs are from the final root artifact):

- Aurora 52/56 are the timestamp-regex equivalents described above (earlier IDs 15/19). ISO validation preserves the accepted valid timestamps.
- Aurora 182 is the harmless undefined-key attempt fallback (earlier ID 145); 187/189 are ignored unknown cursor fallbacks (earlier IDs 150/152).
- Aurora 232 is the nullish lookup in a number-keyed attempt map (earlier ID 195). Aurora 258 removes a redundant null check before the positive bid-count predicate (earlier ID 221).
- Kilter 415 is the redundant log-angle null check (earlier ID 378); 453 is the nullish lookup in a number-keyed grade map (earlier ID 416); 458 removes the redundant null check before the positive attempt-count predicate (earlier ID 421).
- Kilter 295 (`gradeSchema` object removed) and 302 (`climbRating` object removed) are **real malformed-input validation coverage gaps**, not equivalent. Both schemas use `.passthrough()`, so valid facts survive when the object shape is removed. Fresh-import public-client rejection tests for missing/invalid grade identity and missing/invalid rating angle would kill them. Reported to root before edits or further runs.

Root authorized two further fresh-import public rejection tests. Added a catalog record missing `difficultyGradeId` and a personal rating missing `angle`; both must reject with `ZodError`. Focused units now pass 86 tests and Biome/whitespace checks pass. Root will verify the two schema mutation ranges serially; no further Stryker run was started by this agent.

Use the default `.stryker-tmp` temp directory and serialize local runs. Do not override tempDirName to sibling nested directories: the observed copy race above shows sibling sandboxes can be recursively copied.

Retrospective: existing request mocks made public-interface behavioral tests straightforward. Actual mutation replacements exposed omitted boundary and error cases. Parallel custom sandbox copying required investigation; use serialized CI reproduction with the default `.stryker-tmp` directory rather than sibling custom nested temp directories. Suggested future guidance: document the exact CI-range reproduction command and sandbox requirement in the testing runbook; use the write-tests skill for similar coverage work.

Root final targeted Kilter schema verification:2/2 killed,100%, no survivors/uncovered/timeouts/errors. /tmp/pr3181-final-kilter-gaps-mutation.json, same CI config with targets19-24 and39-44, default sandbox. Final40Kiltertests and root typecheck pass.
