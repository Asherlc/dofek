import type { DeveloperClientSecret } from "@dofek/auth/developer-clients";
import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import {
  DeveloperClientSecretPanel,
  DeveloperClientSecretPanelContent,
} from "./DeveloperClientSecretPanel";

const exampleCredential = {
  client: {
    clientId: "ext_example_only",
    name: "Example importer",
    redirectUris: ["https://integration.example/callback"],
    scopes: ["nutrition:write"],
    status: "active",
    createdAt: "2026-08-24T20:00:00.000Z",
    lastRotatedAt: "2026-08-24T20:00:00.000Z",
  },
  clientSecret: "example-placeholder-not-a-real-secret",
} satisfies DeveloperClientSecret;

const meta = {
  title: "Developer Integrations/DeveloperClientSecretPanel",
  component: DeveloperClientSecretPanel,
  args: { onDismiss: () => {}, secret: exampleCredential },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, width: 360 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof DeveloperClientSecretPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VisibleOneTimeSecret: Story = {};

export const ClipboardFailureGuidance: Story = {
  render: () => (
    <DeveloperClientSecretPanelContent
      copyError="Copy failed. Select and copy the value manually."
      onCopyClientId={() => {}}
      onCopyClientSecret={() => {}}
      onDismiss={() => {}}
      secret={exampleCredential}
    />
  ),
};
