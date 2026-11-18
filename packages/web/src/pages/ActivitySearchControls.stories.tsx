import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo, useState } from "react";
import { expect, within } from "storybook/test";
import { trpc } from "../lib/trpc.ts";
import { ActivitySearchControls, type ActivitySearchSelection } from "./ActivitySearchControls.tsx";

const places = [
  { id: "oakland-ca", label: "Oakland, CA, United States", latitude: 37.8, longitude: -122.3 },
  { id: "oakland-or", label: "Oakland, OR, United States", latitude: 43.4, longitude: -123.3 },
];

const placeLink: TRPCLink<AppRouter> = () => () => {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.next?.({ result: { data: places } });
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
};

function SearchStory() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const client = useMemo(() => trpc.createClient({ links: [placeLink] }), []);
  const [selection, setSelection] = useState<ActivitySearchSelection>();
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ActivitySearchControls selection={selection} onSearch={setSelection} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Activities/Search",
  component: SearchStory,
} satisfies Meta<typeof SearchStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const PlaceChoices: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Location" }));
    await userEvent.type(canvas.getByRole("searchbox"), "Oakland");
    await userEvent.click(canvas.getByRole("button", { name: "Look up a place" }));
    await expect(
      await canvas.findByRole("button", { name: "Oakland, CA, United States" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Oakland, OR, United States" })).toBeVisible();
  },
};
