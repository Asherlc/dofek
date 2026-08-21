# @dofek/filter-columns

Shared column-name rules for provider-detail filters. The server uses these
rules to recognize date ranges, while the web app uses them to select the
matching filter input type.

This is a private workspace package with no runtime configuration or external
dependencies.

## Usage

```ts
import {
  getFilterInputType,
  isRangeFilterColumn,
  parseRangeFilterKey,
} from "@dofek/filter-columns";

isRangeFilterColumn("started_at"); // true
parseRangeFilterKey("started_at_from");
// { column: "started_at", bound: "from" }
getFilterInputType("started_at"); // "datetime-local"
```

## Public API

- `FilterInputType`: `"text" | "date" | "datetime-local"`.
- `isDateFilterColumn(column)`: recognizes `date`, `start_date`, and
  `end_date`.
- `isDateTimeFilterColumn(column)`: recognizes `syncedAt`, `synced_at`, and
  names ending in `_at`.
- `isRangeFilterColumn(column)`: returns whether a column is date-only or a
  date-time column.
- `parseRangeFilterKey(key)`: parses a trailing `_from` or `_to` into a column
  name and range bound; returns `null` for other keys.
- `getFilterInputType(columnKey)`: maps date-only columns to `date`, date-time
  columns to `datetime-local`, and all other columns to `text`.

## Development

Run commands from the repository root:

```sh
pnpm --filter @dofek/filter-columns typecheck
pnpm exec vitest run --project unit packages/filter-columns/src/index.test.ts
```

Tests are colocated with the implementation in `src/index.test.ts`.
