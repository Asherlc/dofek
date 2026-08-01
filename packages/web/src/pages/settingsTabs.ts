export type SettingsTab = "general" | "health" | "connections" | "account" | "advanced";

export const SETTINGS_TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "health", label: "Health" },
  { id: "connections", label: "Connections" },
  { id: "account", label: "Account" },
  { id: "advanced", label: "Advanced" },
];

export function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}
