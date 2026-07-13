import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { DataExportSection } from "./DataExportSection";

function DataExportSectionStoryFrame() {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        exports: [
          {
            id: "export-1",
            status: "completed",
            filename: "dofek-export.zip",
            sizeBytes: 2048,
            createdAt: "2026-06-01T12:00:00.000Z",
            startedAt: "2026-06-01T12:01:00.000Z",
            completedAt: "2026-06-01T12:02:00.000Z",
            expiresAt: "2026-06-08T12:00:00.000Z",
            errorMessage: null,
          },
        ],
      }),
      { status: 200 },
    );

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
  render: () => <DataExportSectionStoryFrame />,
};
