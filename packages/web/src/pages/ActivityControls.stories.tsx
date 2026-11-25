import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ActivityControls } from "./ActivityControls.tsx";

const meta = {
  title: "Pages/Activities/Controls",
  component: ActivityControls,
  args: {
    activityTypes: ["cycling", "running"],
    activityType: "all",
    preset: "this-week",
    showHidden: false,
    searching: false,
    canSelect: true,
    selectMode: false,
    confirmDelete: false,
    confirmMerge: false,
    confirmRestore: false,
    selectedCount: 0,
    selectedHiddenCount: 0,
    selectedVisibleCount: 0,
    mergeEligible: false,
    mergePending: false,
    mixedTypes: false,
    deletePending: false,
    restorePending: false,
    onActivityTypeChange: fn(),
    onPresetChange: fn(),
    onShowHiddenChange: fn(),
    onSelect: fn(),
    onCancelSelection: fn(),
    onDeleteSelected: fn(),
    onMergeSelected: fn(),
    onRestoreSelected: fn(),
    onConfirmDelete: fn(),
    onConfirmMerge: fn(),
    onConfirmRestore: fn(),
  },
} satisfies Meta<typeof ActivityControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SelectionMode: Story = {
  args: {
    selectMode: true,
    selectedCount: 2,
    selectedVisibleCount: 2,
    mergeEligible: true,
  },
};
