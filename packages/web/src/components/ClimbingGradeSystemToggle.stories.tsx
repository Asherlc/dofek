import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { ClimbingGradeSystemToggle } from "./ClimbingGradeSystemToggle.tsx";

function createMockLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(
        op.path === "settings.get"
          ? { key: "climbingGradeSystems", value: { boulder: "font", route: "french" } }
          : { key: "climbingGradeSystems", value: op.input },
      );
}

function createMockObservable(data: unknown): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.next?.({ result: { data } });
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function ClimbingGradeSystemStoryFrame() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[420px] p-4">
          <ClimbingGradeSystemToggle />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/ClimbingGradeSystemToggle",
  component: ClimbingGradeSystemToggle,
  tags: ["autodocs"],
} satisfies Meta<typeof ClimbingGradeSystemToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FontAndFrench: Story = {
  render: () => <ClimbingGradeSystemStoryFrame />,
};
