import {
  ghostSessionsCompareInputSchema,
  ghostSessionsPassesInputSchema,
} from "@dofek/training/ghost-sessions";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { z } from "zod";
import {
  ghostActivityId,
  ghostComparison,
  ghostFirstPage,
  ghostFirstVisit,
  ghostNamesReady,
  ghostReady,
  ghostSecondPage,
} from "../app-fixtures/ghost-sessions";
import { trpc } from "../lib/trpc";
import { GhostSessions } from "./GhostSessions";

type Scenario = "comparison" | "loading" | "first-visit" | "error" | "map-names" | "map-name-error";

function storyData(path: string, input: unknown, scenario: Scenario) {
  switch (path) {
    case "settings.get": {
      const { key } = z.object({ key: z.string() }).parse(input);
      return {
        key,
        value:
          key === "ghostMapLabels"
            ? scenario === "map-names" || scenario === "map-name-error"
            : "metric",
      };
    }
    case "ghostSessions.get":
      if (scenario === "first-visit") return ghostFirstVisit;
      if (scenario === "map-names") return ghostNamesReady;
      if (scenario === "map-name-error") return { ...ghostReady, nameStatus: "error" };
      return ghostReady;
    case "ghostSessions.passes": {
      const { cursor, sectionId } = ghostSessionsPassesInputSchema.parse(input);
      if (sectionId === "named:trail-fixture") return { passes: [], nextCursor: null };
      if (sectionId === "named:road-fixture")
        return {
          passes: ghostFirstPage.passes.map((pass) => ({ ...pass, passId: "road-pass" })),
          nextCursor: null,
        };
      return cursor ? ghostSecondPage : ghostFirstPage;
    }
    case "ghostSessions.compare":
      return ghostComparison(ghostSessionsCompareInputSchema.parse(input).passId);
    default:
      throw new globalThis.Error(`Unexpected Ghost Sessions fixture query ${path}`);
  }
}

function Preview({ scenario }: { scenario: Scenario }) {
  const { client, queryClient } = useMemo(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const link: TRPCLink<AppRouter> =
      () =>
      ({ op }) => {
        const result: OperationResultObservable<AppRouter, unknown> = {
          subscribe(observer) {
            if (op.path === "ghostSessions.get" && scenario === "loading")
              return { unsubscribe() {} };
            if (op.path === "ghostSessions.get" && scenario === "error") {
              observer.error?.(new TRPCClientError("Ghost Sessions could not be loaded."));
            } else {
              observer.next?.({ result: { data: storyData(op.path, op.input, scenario) } });
              observer.complete?.();
            }
            return { unsubscribe() {} };
          },
          pipe() {
            return result;
          },
        };
        return result;
      };
    return { queryClient, client: trpc.createClient({ links: [link] }) };
  }, [scenario]);

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ width: "100%", maxWidth: 390, minWidth: 0 }}>
          <GhostSessions activityId={ghostActivityId} />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Activity/Ghost Sessions",
  component: GhostSessions,
  args: { activityId: ghostActivityId },
} satisfies Meta<typeof GhostSessions>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Comparison = { render: () => <Preview scenario="comparison" /> } satisfies Story;
export const Loading = { render: () => <Preview scenario="loading" /> } satisfies Story;
export const FirstVisit = { render: () => <Preview scenario="first-visit" /> } satisfies Story;
export const RequestError = { render: () => <Preview scenario="error" /> } satisfies Story;
export const MapNames = { render: () => <Preview scenario="map-names" /> } satisfies Story;
export const MapNameError = { render: () => <Preview scenario="map-name-error" /> } satisfies Story;
