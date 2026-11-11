# Climbing providers

The requested scope is all sources in the climbing-provider research: Kilter,
Tension, Grasshopper, Decoy, So iLL, Touchstone Board, Crimpd, 8a.nu/Vertical-Life,
MoonBoard, 27 Crags, and Griptonite. Aurora Board uses the same upstream protocol
as the other Aurora boards and is included alongside them.

Use Dofek's existing per-user connections, climbing graph, file-upload jobs,
web and mobile provider controls. Preserve each source occurrence and its raw
payload. Missing grades, names, durations, counts, and outcomes stay unknown.
Do not group timestamped sends into fabricated timed activities.

Kilter uses its current backend, with native log IDs, completion booleans,
grades, and refreshable credentials. Aurora boards use their shared session and
paginated sync protocol; preserve separate ascents/bids and explicit tombstones.
Source evidence: [Kilter client](https://github.com/lemeryfertitta/BoardLib/blob/main/src/boardlib/api/kilter.py),
[Aurora client](https://github.com/lemeryfertitta/BoardLib/blob/main/src/boardlib/api/aurora.py),
[Aurora apps](https://auroraclimbing.com/).

Import Crimpd's documented ZIP/CSV export, 8a.nu's ascent CSV, and existing
MoonBoard BoardLib CSV exports. File uploads are additive and idempotent;
upload absence does not prove a remote deletion. Use recorded set/climb facts,
not vendor-computed workload, aggregate grades, or estimated calorie expenditure.
Sources: [Crimpd export](https://crimpd.com/docs/data-export/),
[8a.nu export](https://www.8a.nu/faq),
[8a.nu CSV fixture](https://github.com/edouardmisset/unified-climbing-projects/blob/main/src/domain/fixtures/8a-nu.fixture.ts),
[BoardLib export](https://github.com/lemeryfertitta/BoardLib).

Add a nullable, storage-only `sourceCompleted` fact for upstream completion
booleans. Keep native textual source results independent, and compute the
existing served outcome in PostgreSQL. Anonymous count-expanded attempts must
not inherit the described attempt's completion.

The user confirmed no additional schema or developer access is available.
27 Crags' JSON shape, Griptonite authorization/payloads, and current MoonBoard
direct sync remain blocked. Document exact missing prerequisites rather than
registering placeholder providers or guessing contracts. Sources:
[27 Crags export](https://27crags-kb-05222019.instantdocsbase.com/help/can-i-export-my-data),
[Griptonite access](https://griptonite.io/gyms/faq/),
[MoonBoard API replacement](https://eu.moonclimbing.com/News/post/moonboard-app-update-important-information).

No branch changes, new per-user environment variables, parallel storage paths,
new upload transport, or speculative compatibility fallbacks. Tests must cover
actual database behavior and both client connection/import flows.
