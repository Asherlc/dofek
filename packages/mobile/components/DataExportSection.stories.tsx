import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { DataExportSection } from "./DataExportSection";

type ExportStoryScenario = "active" | "completed" | "empty" | "error" | "loading";

const completedExport = {
  id: "export-1",
  status: "completed",
  filename: "dofek-export.zip",
  sizeBytes: 2048,
  createdAt: "2026-06-01T12:00:00.000Z",
  startedAt: "2026-06-01T12:01:00.000Z",
  completedAt: "2026-06-01T12:02:00.000Z",
  expiresAt: "2026-06-08T12:00:00.000Z",
  errorMessage: null,
};

const activeExport = {
  ...completedExport,
  id: "export-2",
  status: "processing",
  sizeBytes: null,
  completedAt: null,
};

function installFetchMock(scenario: ExportStoryScenario) {
  if (scenario === "loading") {
    globalThis.fetch = () => new Promise<Response>(() => {});
    return;
  }

  if (scenario === "error") {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Export service is unavailable." } }), {
        status: 503,
      });
    return;
  }

  const exports =
    scenario === "completed" ? [completedExport] : scenario === "active" ? [activeExport] : [];
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ exports }), {
      status: 200,
    });
}

function DataExportSectionStoryFrame({ scenario }: { scenario: ExportStoryScenario }) {
  installFetchMock(scenario);

  return (
    <View style={{ width: 360, padding: 16 }}>
      <DataExportSection serverUrl="https://dofek.example" sessionToken="storybook-token" />
    </View>
  );
}

const meta = {
  title: "Settings/DataExportSection",
  component: DataExportSection,
} satisfies Meta<typeof DataExportSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <DataExportSectionStoryFrame scenario="completed" />,
};

export const Loading: Story = {
  render: () => <DataExportSectionStoryFrame scenario="loading" />,
};

export const Empty: Story = {
  render: () => <DataExportSectionStoryFrame scenario="empty" />,
};

export const ActiveExport: Story = {
  render: () => <DataExportSectionStoryFrame scenario="active" />,
};

export const ErrorState: Story = {
  render: () => <DataExportSectionStoryFrame scenario="error" />,
};
