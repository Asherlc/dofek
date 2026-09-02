# 2026-07-14 Worker OOM Evidence

This record preserves the production observations and controlled-profile summary used to diagnose [issue #1606](https://github.com/Asherlc/dofek/issues/1606). Docker documents that healthcheck commands execute inside the service container and that processes in a memory-limited container are subject to its cgroup limit ([healthcheck configuration](https://docs.docker.com/reference/compose-file/services/#healthcheck), [memory constraints](https://docs.docker.com/engine/containers/resource_constraints/)).

## Production capture

The incident image was `ghcr.io/asherlc/dofek:sha-51b83b3`. The retained Docker, Swarm, and cgroup capture contained these values:

| Observation | Captured value |
|---|---:|
| OOM timestamp | `2026-07-14T20:15:51.556Z` |
| Docker state | `OOMKilled=true`, exit code `137` |
| Swarm state | `task: non-zero exit (137)` |
| Cgroup memory | `419,430,400` bytes |
| Main Node anonymous memory | `344,543,232` bytes |
| Healthcheck Node anonymous memory | `65,556,480` bytes |
| Host available memory | approximately 9 GiB |
| Last retained healthcheck completion | `2026-07-14T20:15:38.915Z` |
| Expected next healthcheck start | approximately `2026-07-14T20:15:48.915Z` |

At the kill, the Garmin parent had been active since `20:13:44Z`; two ZIP extractors were active, 283 child jobs were terminal, and 1,009 were waiting. The worker also owned an active WHOOP heart-rate step and a Strava job active since `19:23:15Z`. The fatal WHOOP step had not emitted its response-header event.

## Controlled exact-image profile

The exact incident image was replayed under the 419,430,400-byte limit with production Node instrumentation, the production health command and cadence, a synthetic 1,294-entry Garmin allocation, and three 100,000-value WHOOP windows. The synthetic counters describe fixture allocation, not executed BullMQ children.

| Variant | Concurrent current-memory runs | Maximum cgroup peak | Healthcheck process |
|---|---|---:|---:|
| Healthcheck on | `350,654,464`, `414,978,048`, `402,284,544` bytes | `416,161,792` bytes | `59–61` MiB anonymous memory |
| Healthcheck off | `364,929,024`, `376,233,984`, `361,672,704` bytes | `376,233,984` bytes | absent |

The highest healthcheck-on overlap left `337,207,296` bytes for the primary workload after subtracting the measured 59,473,920-byte probe, within 7,335,936 bytes of the production main process. The production cgroup capture—not the synthetic run by itself—establishes that the main process, healthcheck process, and kernel memory reached the configured limit.

The retained raw profile artifacts are gitignored because they include multi-megabyte sample series. Their SHA-256 digests are:

- healthcheck on: `64d4b75983686832ff15cd422ce8fcec7af89f0535d169eb7ba882b20147def6`
- healthcheck off: `3be4a581107d3dc9165527f2e6cce1a8cad26554752f53323731ab9dcc445571`
- exact-image isolated profile: `987454ae28cc3558a9dbba40234d6cc1d9484271b7bdc8140ab28573d92f1cb1`

## Validation artifacts

The final PR revision passed the [complete CI run](https://github.com/Asherlc/dofek/actions/runs/29386899805), including:

- [11,699 unit tests in 595 files](https://github.com/Asherlc/dofek/actions/runs/29386899805/job/87262093631), with 21 tests and two files skipped by their declared conditions;
- the [unit and integration test gate](https://github.com/Asherlc/dofek/actions/runs/29386899805/job/87263034432);
- all mutation shards and the [mutation-testing gate](https://github.com/Asherlc/dofek/actions/runs/29386899805/job/87263784522), including a [100 percent Stryker result](https://github.com/Asherlc/dofek/actions/runs/29386899805/job/87262133382) for the shard containing the import worker changes.

The isolated real-Redis restart test and `docker stack config --compose-file deploy/stack.yml` also passed locally before the reviewed revision was pushed; neither command mutated production state.
