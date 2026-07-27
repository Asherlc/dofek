export type SlackCredentialColumn = "bot_token" | "raw_installation";

export function slackCredentialContext(
  teamId: string,
  columnName: SlackCredentialColumn,
): {
  columnName: SlackCredentialColumn;
  scopeId: string;
  tableName: "fitness.slack_installation";
} {
  return {
    tableName: "fitness.slack_installation",
    columnName,
    scopeId: teamId,
  };
}
