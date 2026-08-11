import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { ClimbingGradeSystemToggle } from "./ClimbingGradeSystemToggle.tsx";

type GradeSystemStoryState = "default" | "error" | "loading" | "preference";

function createMockLink(state: GradeSystemStoryState): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(
        state,
        op.path === "settings.get"
          ? {
              key: "climbingGradeSystems",
              value: state === "preference" ? { boulder: "font", route: "french" } : null,
            }
          : { key: "climbingGradeSystems", value: op.input },
      );
}

function createMockObservable(
  state: GradeSystemStoryState,
  data: unknown,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (state === "loading") return { unsubscribe: () => {} };
      if (state === "error") {
        observer.error?.(new Error("Could not load climbing grade systems."));
        return { unsubscribe: () => {} };
      }
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

function ClimbingGradeSystemStoryFrame({ state }: { state: GradeSystemStoryState }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink(state)] }), [state]);

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
  render: () => <ClimbingGradeSystemStoryFrame state="preference" />,
};

export const Default: Story = {
  render: () => <ClimbingGradeSystemStoryFrame state="default" />,
};

export const Loading: Story = {
  render: () => <ClimbingGradeSystemStoryFrame state="loading" />,
};

export const ErrorState: Story = {
  render: () => <ClimbingGradeSystemStoryFrame state="error" />,
};
