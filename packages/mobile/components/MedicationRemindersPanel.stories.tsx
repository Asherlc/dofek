import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { MedicationRemindersPanel } from "./MedicationRemindersPanel";

const meta = {
  title: "Settings/MedicationRemindersPanel",
  component: MedicationRemindersPanel,
} satisfies Meta<typeof MedicationRemindersPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => (
    <View style={{ padding: 16 }}>
      <MedicationRemindersPanel
        remindersQueryResult={{
          isLoading: false,
          error: null,
          data: { key: "medicationReminders", value: [] },
        }}
        doseEventsQueryResult={{
          isLoading: false,
          error: null,
          data: { events: [] },
        }}
      />
    </View>
  ),
};

export const WithLoggingState: Story = {
  render: () => (
    <View style={{ padding: 16 }}>
      <MedicationRemindersPanel
        focusedReminderId="11111111-1111-4111-8111-111111111111"
        remindersQueryResult={{
          isLoading: false,
          error: null,
          data: {
            key: "medicationReminders",
            value: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                medicationName: "Vitamin D3",
                localTime: "08:30",
                enabled: true,
              },
            ],
          },
        }}
        doseEventsQueryResult={{
          isLoading: false,
          error: null,
          data: {
            events: [
              {
                id: "event-1",
                providerId: "apple_health",
                medicationName: "Vitamin D3",
                medicationConceptId: null,
                doseStatus: "taken",
                recordedAt: "2026-07-25T16:00:00.000Z",
                sourceName: "Apple Health",
              },
            ],
          },
        }}
      />
    </View>
  ),
};

export const Loading: Story = {
  render: () => (
    <View style={{ padding: 16 }}>
      <MedicationRemindersPanel
        remindersQueryResult={{ isLoading: true, error: null, data: null }}
        doseEventsQueryResult={{ isLoading: true, error: null, data: null }}
      />
    </View>
  ),
};
