# PR 3181 import parser mutation coverage

Scope: only colocated unit tests for eight-a/parser.ts, moonboard/parser.ts, crimpd/archive.ts. No production changes or shared helper changes.

CI evidence: archive.ts:1-85 66.67% (19 survived, 6 uncovered); moonboard/parser.ts:1-82 74.65% (18 survived); eight-a/parser.ts:1-75 62.86% (26 survived). Actual mutant replacements were read from /tmp/pr3181-mutations/mutation-report-{4,5,6}/mutation.json.

Added public-interface assertions for ascent qualifiers, rope methods, unknown disciplines, area order/filtering, raw payload fidelity and source IDs; supported setup identifiers, complete booleans, zero/absent/boundary angles, exact/unknown counts and grade-system selection; ZIP validation cause, compression error classification, unexpected error identity, required empty members, unknown-member skipping, options and close lifecycle.

Review checkpoint: tests only, no mutation exclusions or threshold/config changes. Focused suite: 55 tests passed after the final gap-closing follow-up. Root TypeScript check: pnpm exec tsc --noEmit --pretty false passed. Biome check on three changed files passed.

Final mutation command: pnpm exec stryker run /tmp/ci3181-import-parsers-stryker.json. Config is copied from stryker.ci.config.json, changing only mutate targets, unique tempDirName under .stryker-tmp and jsonReporter.fileName. CI concurrency=2, related=true, normal discovery and all other settings preserved. Log: /tmp/ci3181-import-parsers-stryker.log; JSON report: /tmp/ci3181-import-parsers-mutation.json.

Mutation results: PASS, 96.76% overall, 209 killed, 7 survived, 0 uncovered, 0 timeouts, 0 runtime errors. Exact ranges: archive.ts:1-85 = 98.67% (74 killed / 1 survived), eight-a/parser.ts:1-75 = 97.14% (68 / 2), moonboard/parser.ts:1-82 = 94.37% (67 / 4). Initial exact-config run discovered and passed 325 related tests. Completed in 6m38s. JSON: /tmp/ci3181-import-parsers-mutation.json. Log: /tmp/ci3181-import-parsers-stryker.log.

Remaining survivor classification (no exclusions or source edits):
- archive mutant69, line60 `error && !stream`: real untested callback-edge distinction. Current fixtures cover success with stream and failure without stream. Killing it requires either an error accompanied by a stream (preserve original error) or missing stream without an error (explicit fallback error). SDK typings require a stream; production retains defensive handling. This is not claimed equivalent.
- eight-a mutant195, line59 `tries !== null` -> `true`: equivalent for exportCount's number|null output because null > 0 is false.
- moonboard mutant241, line40 `angle !== null` -> `true`: equivalent for exportNumber's number|null output because both null < -90 and null > 90 are false.
- moonboard mutant307, line66 `tries !== null` -> `true`: same count equivalence as eight-a.
- moonboard mutant284, line56 `row.logged_grade && row.displayed_grade`: real remaining grade-system-selection case. A conflicting logged V-scale grade and displayed Font grade would distinguish it; current V-scale fixtures use V-scale for both grades. This is not claimed equivalent.
- eight-a mutant94 and moonboard mutant210 replace header arrays with []. Both reports mark static=true and list provider-registry/aggregate consumers as covered tests. They are not equivalent: parser header validation is meaningful and existing dedicated invalid-header assertions should reject these replacements when actually selected. CI's unchanged static/related-test selection accounts for their survivor classification; no weakening was introduced.

Sandbox finding: absolute external /tmp sandboxes found only84 related tests and immediately reported all mutations surviving. A unique `.stryker-tmp/ci3181-import-parsers` sandbox found325 related tests and produced the valid passing results above. Exact config copy changes only mutate targets, unique standard-prefix tempDirName and absolute jsonReporter.fileName. No sandboxes were deleted after the root final verification began.


Retrospective: exact assertions and boundary cases addressed the observable gaps without production changes. TypeScript overloaded callbacks required accurate optional callback signatures. Next time use the CI config with the default .stryker-tmp sandbox and serialize local mutation runs. Do not use sibling custom sandboxes: they can copy one another and race cleanup. Recommended skill: write-tests.

## Final gap-closing follow-up

After the scored run, closed both actual remaining test gaps: the stream-opening error fixture now supplies both an error and a partial stream, verifying that the original error wins; a conflicting logged V3/displayed 7A MoonBoard row verifies the logged grade determines the system. Both invalid-header cases now call vi.resetModules() and dynamically import their parser inside the test, so static header initialization is evaluated while the test is active rather than only through registry imports.

Verification after these edits: 55 focused tests passed across the three colocated files; Biome passed; git diff --check passed. No additional Stryker run was started, per root coordination; the 96.76% scores above describe the preceding snapshot, and the later tests target its four non-equivalent survivors. The three null-guard equivalents remain as documented. No source/config/sandbox changes or commits.

Root follow-up targeted mutation verification passes100% for archive line60, eight-a header, MoonBoard header and grade-selection line56. Report /tmp/pr3181-final-import-gaps-mutation.json; same CI configuration, default sandbox, no threshold/exclusion changes.
