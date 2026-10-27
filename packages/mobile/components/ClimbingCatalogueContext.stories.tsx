import type { ClimbingCatalogueContext as Context } from "@dofek/training/climbing-catalogue";
import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { fn } from "storybook/test";
import { ClimbingCatalogueContextView } from "./ClimbingCatalogueContext";

const missing: Context = {
  status: "missing",
  fetchedAt: null,
  expiresAt: null,
  error: null,
  sources: [],
};
const ready: Context = {
  ...missing,
  status: "ready",
  fetchedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  sources: [
    {
      providerId: "kaya",
      searchComplete: true,
      matches: [
        {
          confidence: "source",
          candidate: {
            providerId: "kaya",
            externalId: "1",
            url: "https://kaya-app.kayaclimb.com/climb/1",
            name: "The Arete",
            kind: "route",
            setting: "outdoor",
            locations: [{ name: "The Valley", scope: "area", externalId: null, coordinates: null }],
            grade: "5.9",
            angle: { value: 25, unit: null },
            tags: [
              {
                kind: "climb_type",
                sourceKey: "type",
                label: "Trad",
                category: null,
                scope: "direct",
                inheritedFrom: null,
              },
              {
                kind: "climb_type",
                sourceKey: "type",
                label: "Sport",
                category: null,
                scope: "direct",
                inheritedFrom: null,
              },
              {
                kind: "climb_type",
                sourceKey: "type",
                label: "Top rope",
                category: null,
                scope: "direct",
                inheritedFrom: null,
              },
              {
                kind: "steepness",
                sourceKey: "slab",
                label: "Slab",
                category: null,
                scope: "inherited",
                inheritedFrom: "The Valley",
              },
              {
                kind: "steepness",
                sourceKey: "overhang",
                label: "Overhang",
                category: null,
                scope: "direct",
                inheritedFrom: null,
              },
              {
                kind: "hold",
                sourceKey: "crimp",
                label: "Crimps",
                category: null,
                scope: "inherited",
                inheritedFrom: "The Valley",
              },
            ],
          },
        },
      ],
    },
  ],
};
const meta = {
  title: "Climbing/ClimbingCatalogueContext",
  component: ClimbingCatalogueContextView,
  args: { context: ready, open: true, onToggle: fn(), onRefresh: fn() },
  parameters: { layout: "padded" },
  render: function CatalogueStory(args) {
    const [open, setOpen] = useState(args.open);
    return <ClimbingCatalogueContextView {...args} open={open} onToggle={() => setOpen(!open)} />;
  },
} satisfies Meta<typeof ClimbingCatalogueContextView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OwnSource: Story = {};
export const Missing: Story = { args: { context: missing } };
export const Collapsed: Story = { args: { open: false } };
export const Pending: Story = { args: { context: { ...missing, status: "pending" } } };
export const Empty: Story = { args: { context: { ...missing, status: "ready" } } };
export const RefreshError: Story = {
  args: { error: "Catalogue lookup unavailable. Try again later." },
};
export const PossibleMatch: Story = {
  args: {
    context: {
      ...ready,
      sources: ready.sources.map((source) => ({
        ...source,
        searchComplete: false,
        matches: source.matches.map((match) => ({ ...match, confidence: "possible" })),
      })),
    },
  },
};
export const CorroboratedMatch: Story = {
  args: {
    context: {
      ...ready,
      sources: ready.sources.map((source) => ({
        ...source,
        matches: source.matches.map((match) => ({ ...match, confidence: "corroborated" })),
      })),
    },
  },
};
