import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ActivityTable, type ActivityTableColumn } from "./ActivityTable.tsx";

interface ActivityRow {
  id: string;
  name: string;
  date: string;
  duration: string;
}

const rows: ActivityRow[] = [
  { id: "activity-1", name: "Morning Run", date: "Mar 18, 2026", duration: "45 min" },
  { id: "activity-2", name: "Trainer Ride", date: "Mar 17, 2026", duration: "1 hr 12 min" },
];

const columns: ActivityTableColumn<ActivityRow>[] = [
  {
    key: "date",
    label: "Date",
    headerClassName: "pb-2 pr-4",
    cellClassName: "py-3 pr-4 text-muted",
    renderCell: (row) => row.date,
  },
  {
    key: "name",
    label: "Activity",
    headerClassName: "pb-2 pr-4",
    cellClassName: "py-3 pr-4 font-medium text-foreground",
    renderCell: (row) => row.name,
  },
  {
    key: "duration",
    label: "Duration",
    headerClassName: "pb-2 text-right",
    cellClassName: "py-3 text-right tabular-nums text-muted",
    renderCell: (row) => row.duration,
  },
];

function ActivityTableStory({ empty = false }: { empty?: boolean }) {
  return (
    <ActivityTable
      rows={empty ? [] : rows}
      columns={columns}
      getRowKey={(row) => row.id}
      getActivityId={(row) => row.id}
      footer={
        empty ? (
          <p className="py-6 text-center text-sm text-dim">No activities in this period.</p>
        ) : null
      }
    />
  );
}

function StoryFrame({ empty = false }: { empty?: boolean }) {
  const rootRoute = createRootRoute({ component: Outlet });
  const storyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ActivityTableStory empty={empty} />,
  });
  const activityRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "activity/$id",
    component: () => (
      <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
        Activity detail selected. Use the browser back action to return to the table.
      </p>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([storyRoute, activityRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return (
    <div className="w-[760px] bg-page p-6">
      <RouterProvider router={router} />
    </div>
  );
}

const meta = {
  title: "Activities/ActivityTable",
  component: ActivityTableStory,
  tags: ["autodocs"],
} satisfies Meta<typeof ActivityTableStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <StoryFrame />,
};

export const EmptyWithFooter: Story = {
  render: () => <StoryFrame empty />,
};
