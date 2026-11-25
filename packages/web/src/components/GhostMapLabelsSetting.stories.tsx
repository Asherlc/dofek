import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fixtureQuery, GhostFixtureProvider, ghostResponse } from "./fixtures/ghost-sessions.tsx";
import { GhostMapLabelsSetting } from "./GhostMapLabelsSetting.tsx";

function StoryFrame({ enabled }: { enabled: boolean }) {
  const [fetchResponse] = useState((): typeof fetch => {
    let value = enabled;
    return async (input, init) => {
      if (fixtureQuery(input).path === "/trpc/settings.set") {
        value = JSON.parse(String(init?.body)).value === true;
      }
      return ghostResponse({ key: "ghostMapLabels", value });
    };
  });
  return (
    <div className="card max-w-md p-4">
      <GhostFixtureProvider fetchResponse={fetchResponse}>
        <GhostMapLabelsSetting />
      </GhostFixtureProvider>
    </div>
  );
}

const meta = {
  title: "Settings/Ghost Sessions Map Labels",
  component: GhostMapLabelsSetting,
  parameters: { layout: "centered" },
} satisfies Meta<typeof GhostMapLabelsSetting>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Off: Story = {
  render: () => <StoryFrame enabled={false} />,
};

export const Enabled: Story = {
  render: () => <StoryFrame enabled />,
};
