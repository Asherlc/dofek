# Retained local release qualification — November 11, 2026

These excerpts were copied on November 13 from the original operator-workstation logs. They preserve local test results, not affected-device acceptance. The source hashes identify the full retained logs; only the bounded summary lines are committed here. The [incident record](../incidents/2026-11-10-sentry-remediation.md#approved-native-purge-tracing) supplies the investigation context.

## One-worker unit/mobile run

Source: `native-purge-tracing-unit-mobile-serial.log`. SHA256: `5a740be275b594115950592e2e496f6ed67b721dce149c87e687939cf962ea55`.

```text
 Test Files  1468 passed | 2 skipped (1470)
      Tests  24370 passed | 19 skipped (24389)
   Duration  2962.47s (tests 40%, import 26%, environment 18%, setup 12%, transform 4%, worker 1%)
```

## Standalone Swift suite

Source: `native-purge-tracing-swift-final.log`. SHA256: `03f44f84a900c042eb3ffaa6c04df0e19409bbbec4cdeb7fe8b9024594c56c65`.

```text
	 Executed 201 tests, with 0 failures (0 unexpected) in 33.293 (33.665) seconds
	 Executed 201 tests, with 0 failures (0 unexpected) in 33.293 (33.673) seconds
```

## Final store suite

Source: `native-purge-tracing-store-final.log`. SHA256: `0c63f7fe32f0e7e1daa976eed0d755783d1cb6e94e14480be957a203902c3d73`.

```text
	 Executed 26 tests, with 0 failures (0 unexpected) in 12.977 (13.008) seconds
	 Executed 26 tests, with 0 failures (0 unexpected) in 12.977 (13.008) seconds
	 Executed 26 tests, with 0 failures (0 unexpected) in 12.977 (13.022) seconds
```

The initial contended run was interrupted and has no final test summary. The load readings and isolated CDC timing in the incident narrative remain operator-session observations; separate raw-output artifacts for those observations are not included in this record. Independent hosted validation is retained in [PR CI](https://github.com/Asherlc/dofek/actions/runs/42973933779), [main CI](https://github.com/Asherlc/dofek/actions/runs/42979751663), and the [canonical release](https://github.com/Asherlc/dofek/actions/runs/42982697452).
