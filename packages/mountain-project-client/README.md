# @dofek/mountain-project

Unofficial TypeScript client for Mountain Project's public tick-history export.

This package is not affiliated with or supported by Mountain Project or onX.
It fetches only `GET /user/{id}/{slug}/tick-export`, an observed CSV export
endpoint. The endpoint is undocumented and can change without notice.

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
```

Use `decodeMountainProjectTickExport` from `@dofek/mountain-project/ticks` to
turn the CSV into typed tick rows. Use `normalizeMountainProjectGrade` from
`@dofek/mountain-project/grades` for the leading YDS/V-scale grade token.
