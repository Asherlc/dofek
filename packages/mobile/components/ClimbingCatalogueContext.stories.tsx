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
          evidence: ["Same provider and climb ID as the logged source."],
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
export const Empty: Story = {
  args: {
    context: {
      ...missing,
      status: "ready",
      sources: [{ providerId: "openbeta", searchComplete: true, matches: [] }],
    },
  },
};
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
        matches: source.matches.map((match) => ({
          ...match,
          confidence: "possible",
          evidence: ["Local geography is not independently corroborated."],
        })),
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
        matches: source.matches.map((match) => ({
          ...match,
          confidence: "corroborated",
          evidence: ["Matching name and independently corroborated local area."],
        })),
      })),
    },
  },
};

const goatRock = {
  externalId: null,
  name: "Goat Rock",
  scope: "area",
  coordinates: { latitude: 37.2282, longitude: -122.1079 },
} as const;
const goatRockReference: Context = {
  ...ready,
  sources: [
    {
      providerId: "mountain-project",
      searchComplete: true,
      matches: [
        {
          confidence: "source",
          evidence: ["Same Mountain Project route ID as the logged climb."],
          candidate: {
            providerId: "mountain-project",
            externalId: "105736399",
            url: "https://www.mountainproject.com/route/105736399/cheddar-corner",
            name: "Cheddar Corner",
            kind: "route",
            setting: "outdoor",
            locations: [goatRock],
            grade: "5.8-",
            angle: null,
            tags: [
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
            ],
          },
        },
      ],
    },
    {
      providerId: "openbeta",
      searchComplete: true,
      searchArea: goatRock,
      matches: [
        {
          confidence: "reference",
          evidence: [
            "Explicit Mountain Project reference 105736399.",
            "Catalogue name differs from the logged name.",
          ],
          candidate: {
            providerId: "openbeta",
            externalId: "f3a2b199-c2d3-59b8-8f12-dd7ce734e88b",
            url: "https://openbeta.io/climb/f3a2b199-c2d3-59b8-8f12-dd7ce734e88b/corner-route",
            name: "Corner Route",
            kind: "route",
            setting: null,
            locations: [goatRock],
            grade: "5.8-",
            angle: null,
            tags: [
              {
                kind: "climb_type",
                sourceKey: "trad",
                label: "Trad",
                category: null,
                scope: "direct",
                inheritedFrom: null,
              },
            ],
            references: [{ providerId: "mountain-project", externalId: "105736399" }],
          },
        },
      ],
    },
  ],
};

export const GoatRockProviderReference: Story = {
  args: { context: goatRockReference },
};
export const ConflictingPossibleMatch: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Illustrative contradictory server response; the reference cannot erase a conflicting local area.",
      },
    },
  },
  args: {
    context: {
      ...goatRockReference,
      sources: goatRockReference.sources
        .filter((source) => source.providerId === "openbeta")
        .map((source) => ({
          ...source,
          searchComplete: false,
          matches: source.matches.map((match) => ({
            ...match,
            confidence: "possible",
            evidence: [
              "Explicit Mountain Project reference 105736399.",
              "Conflict: local areas differ: Goat Rock and Chew Tooth.",
            ],
            candidate: {
              ...match.candidate,
              locations: [{ ...goatRock, name: "Chew Tooth", coordinates: null }],
            },
          })),
        })),
    },
  },
};
export const IncompleteLocalSearch: Story = {
  args: {
    context: {
      ...ready,
      sources: [
        { providerId: "openbeta", searchComplete: false, searchArea: goatRock, matches: [] },
      ],
    },
  },
};
