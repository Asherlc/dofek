import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { PaginationControls } from "./PaginationControls.tsx";

function PaginationControlsStory() {
  const [page, setPage] = useState(1);

  return (
    <div className="w-[520px] rounded-lg border border-border bg-surface p-4">
      <PaginationControls
        page={page}
        pageSize={20}
        totalItems={67}
        itemLabel="activities"
        onPageChange={setPage}
      />
    </div>
  );
}

const meta = {
  title: "Navigation/PaginationControls",
  component: PaginationControlsStory,
  tags: ["autodocs"],
} satisfies Meta<typeof PaginationControlsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
