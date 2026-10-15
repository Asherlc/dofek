# @dofek/mountain-project

Unofficial TypeScript client for Mountain Project's public tick-history export
and route/Area location metadata.

This package is not affiliated with or supported by Mountain Project or onX.
It reads the observed [CSV export](https://www.mountainproject.com/user/200232920/cole-schmidt/tick-export),
[route JSON](https://www.mountainproject.com/api/v2/routes/105734660), and
[Area JSON](https://www.mountainproject.com/api/v2/areas/105734057) endpoints.
These application endpoints are undocumented and can change without notice.

Use it only for data you are authorized to access. The Dofek provider stores a
user's profile ID as its connection value and does not collect Mountain Project
credentials.

## API

```ts
import {
  MountainProjectClient,
  parseMountainProjectProfileId,
} from "@dofek/mountain-project";

const userId = parseMountainProjectProfileId(
  "https://www.mountainproject.com/user/110186720/example-user",
);
const csv = await new MountainProjectClient().getTickExport(userId);
const route = await new MountainProjectClient().getRoute("105734660");
const area = await new MountainProjectClient().getArea(String(route.parent.id));
```

Use `decodeMountainProjectTickExport` from `@dofek/mountain-project/ticks` to
turn the CSV into typed tick rows. Use `parseMountainProjectGrades` from
`@dofek/mountain-project/grades` for the recorded grade components, including
compound free, aid, ice and mixed grades. `normalizeMountainProjectGrade`
supplies the leading YDS/V-scale grade used by that parser. Published `Rating`
and separately supplied `Your Rating` remain separate fields in the observed
[public export](https://www.mountainproject.com/user/200232920/cole-schmidt/tick-export).

`getRoute` and `getArea` validate the returned identity and parent reference;
`getArea` also validates native longitude/latitude pairs. Their `raw` field
retains the upstream JSON. The observed root Area uses parent ID `0`, which
is a sentinel rather than a fetchable Area. Route `parent.coordinates` belongs
to the parent Area; the client exposes native coordinates only on Area results.
These ownership and root conventions were verified against the
[route](https://www.mountainproject.com/api/v2/routes/105734660),
[leaf Area](https://www.mountainproject.com/api/v2/areas/105734057), and
[root Area](https://www.mountainproject.com/api/v2/areas/105708959) on 2026-10-14.
