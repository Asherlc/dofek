import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  type DeveloperClientSupportItem,
  DeveloperClientsAdminPanelContent,
} from "./DeveloperClientsAdminPanel.tsx";

const activeClient = {
  clientId: "ext_active_client_fixture",
  name: "Meal importer",
  ownerName: "Ada Owner",
  ownerEmail: "ada@example.test",
  scopes: ["nutrition:write"],
  status: "active",
  createdAt: "2026-08-20T18:00:00.000Z",
  lastRotatedAt: "2026-08-24T18:00:00.000Z",
} satisfies DeveloperClientSupportItem;

const revokedClient = {
  ...activeClient,
  clientId: "ext_revoked_client_fixture",
  name: "Retired importer",
  status: "revoked",
} satisfies DeveloperClientSupportItem;

function PanelStory({
  clients,
  error = null,
  isLoading = false,
}: {
  clients: DeveloperClientSupportItem[] | undefined;
  error?: unknown;
  isLoading?: boolean;
}) {
  const [selectedClient, setSelectedClient] = useState<DeveloperClientSupportItem | null>(null);
  return (
    <div className="min-h-screen bg-background p-8">
      <DeveloperClientsAdminPanelContent
        clients={clients}
        error={error}
        isLoading={isLoading}
        isRevoking={false}
        mutationError={null}
        onCancelRevoke={() => setSelectedClient(null)}
        onConfirmRevoke={() => setSelectedClient(null)}
        onRequestRevoke={setSelectedClient}
        selectedClient={selectedClient}
      />
    </div>
  );
}

const meta = {
  title: "Admin/DeveloperClientsAdminPanel",
  component: DeveloperClientsAdminPanelContent,
  parameters: { layout: "fullscreen" },
  args: {
    clients: [],
    error: null,
    isLoading: false,
    isRevoking: false,
    mutationError: null,
    onCancelRevoke: () => {},
    onConfirmRevoke: () => {},
    onRequestRevoke: () => {},
    selectedClient: null,
  },
} satisfies Meta<typeof DeveloperClientsAdminPanelContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  render: () => <PanelStory clients={undefined} isLoading />,
};

export const Empty: Story = {
  render: () => <PanelStory clients={[]} />,
};

export const QueryError: Story = {
  render: () => (
    <PanelStory clients={undefined} error={new Error("Support inventory unavailable")} />
  ),
};

export const Active: Story = {
  render: () => <PanelStory clients={[activeClient]} />,
};

export const Revoked: Story = {
  render: () => <PanelStory clients={[revokedClient]} />,
};
