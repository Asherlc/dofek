import { ActivityIndicator, Text, View } from "react-native";
import { colors } from "../../theme";
import { getQueryErrorMessage, QueryStatePanel } from "../QueryStatePanel";
import type { SyncLog } from "./provider-card.tsx";
import { SyncLogRow } from "./provider-card.tsx";
import { styles } from "./styles.ts";

export function ProviderSyncHistory({
  data,
  error,
  isLoading,
}: {
  data: SyncLog[] | undefined;
  error: unknown;
  isLoading: boolean;
}) {
  const logs = data ?? [];
  return (
    <>
      <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Sync History</Text>
      {error ? (
        <View style={styles.card}>
          <QueryStatePanel
            variant="error"
            title={
              data === undefined ? "Could not load sync history" : "Could not refresh sync history"
            }
            message={getQueryErrorMessage(error, "Failed to load sync history.")}
          />
        </View>
      ) : null}
      {isLoading && data === undefined ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
      ) : error && data === undefined ? null : logs.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>No sync history yet.</Text>
        </View>
      ) : (
        <View style={styles.card}>
          {logs.map((log) => (
            <SyncLogRow key={log.id} log={log} />
          ))}
        </View>
      )}
    </>
  );
}
