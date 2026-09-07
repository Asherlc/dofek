export type SettingsCategory =
  | "account"
  | "data-sources"
  | "goals-models"
  | "privacy-export"
  | "notifications"
  | "billing"
  | "advanced";

export const SETTINGS_CATEGORIES: readonly {
  id: SettingsCategory;
  label: string;
  searchText: string;
}[] = [
  {
    id: "account",
    label: "Account",
    searchText: "account linked accounts password help support",
  },
  {
    id: "data-sources",
    label: "Data Sources",
    searchText: "data sources providers Zepp integrations",
  },
  {
    id: "goals-models",
    label: "Goals & Models",
    searchText:
      "goals models primary goal units journal trends health reports goal weight algorithm personalization",
  },
  {
    id: "privacy-export",
    label: "Privacy/Export",
    searchText: "privacy export data export download delete danger zone",
  },
  {
    id: "notifications",
    label: "Notifications",
    searchText: "notifications medication reminders medication doses",
  },
  {
    id: "billing",
    label: "Billing",
    searchText: "billing subscription access checkout",
  },
  {
    id: "advanced",
    label: "Advanced",
    searchText: "advanced dashboard layout MCP developer integrations OAuth callback API",
  },
];

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return SETTINGS_CATEGORIES.some((category) => category.id === value);
}

const LEGACY_SETTINGS_CATEGORY_MAP: Readonly<Record<string, SettingsCategory>> = {
  connections: "data-sources",
  general: "goals-models",
  health: "goals-models",
};

export function normalizeSettingsCategory(value: unknown): SettingsCategory | undefined {
  if (isSettingsCategory(value)) return value;
  return typeof value === "string" ? LEGACY_SETTINGS_CATEGORY_MAP[value] : undefined;
}
