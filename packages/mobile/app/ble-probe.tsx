import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  addNotificationListener,
  type BleNotification,
  connect,
  disconnect,
  discoverCharacteristics,
  discoverServices,
  getConnectedPeripherals,
  isConnected,
  scan,
  subscribe,
  writeRaw,
} from "../modules/ble-probe";
import { colors, fontSize, fonts, spacing } from "../theme";

// Known WHOOP service UUIDs
const WHOOP_SERVICES = [
  "61080001-8d6d-82b8-614a-1c8cb0f8dcc6",
  "fd4b0001-cce1-4033-93ce-002d5875f58a",
  "11500001-6215-11ee-8c99-0242ac120002",
];

interface LogEntry {
  id: string;
  text: string;
  type: "info" | "error" | "data" | "command";
}

let logId = 0;

export default function BleProbeScreen() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [commandInput, setCommandInput] = useState("");
  const [connectedDevice, setConnectedDevice] = useState<string | null>(null);
  const [notificationCount, setNotificationCount] = useState(0);
  const flatListRef = useRef<FlatList>(null);

  const addLog = useCallback((text: string, type: LogEntry["type"] = "info") => {
    logId += 1;
    setLogs((prev) => [...prev.slice(-500), { id: String(logId), text, type }]);
  }, []);

  // Listen for BLE notifications
  useEffect(() => {
    const subscription = addNotificationListener((notification: BleNotification) => {
      setNotificationCount((count) => count + 1);
      // Stream to Metro console for terminal-side analysis
      // biome-ignore lint/suspicious/noConsole: intentional debug logging for BLE RE
      console.log(`[BLE] #${notification.index} [${notification.suffix}] ${notification.bytes}B: ${notification.hex}`);
      // Only show first 20 and then every 50th in the UI to avoid flooding
      const index = notification.index;
      if (index <= 20 || index % 50 === 0) {
        addLog(
          `#${index} [${notification.suffix}] ${notification.bytes}B: ${notification.hex.slice(0, 80)}${notification.hex.length > 80 ? "..." : ""}`,
          "data",
        );
      }
    });
    return () => subscription.remove();
  }, [addLog]);

  // === AUTO-COMMAND: edit this to send commands from the terminal ===
  // Every time this file is saved, this runs on the phone via hot-reload.
  // Change the command string below and save to execute it remotely.
  useEffect(() => {
    const autoCommand = ""; // disabled
    if (autoCommand) {
      // biome-ignore lint/suspicious/noConsole: intentional debug logging
      console.log(`[BLE-AUTO] executing: ${autoCommand}`);
      executeCommand(autoCommand);
    }
  }, [executeCommand]);

  const executeCommand = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      addLog(`> ${trimmed}`, "command");

      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      try {
        switch (cmd) {
          case "scan": {
            addLog("Scanning for all BLE devices (5s)...");
            const results = await scan(undefined, 5);
            addLog(`Found ${results.length} devices:`);
            for (const device of results) {
              addLog(`  ${device.name ?? "unnamed"} [${device.id}] RSSI=${device.rssi}`);
            }
            break;
          }

          case "whoop": {
            addLog("Checking for already-connected WHOOP straps...");
            const connected = getConnectedPeripherals(WHOOP_SERVICES);
            if (connected.length > 0) {
              const device = connected[0];
              addLog(`Found: ${device.name ?? "unnamed"} [${device.id}]`);
              addLog("Auto-connecting...");
              const result = await connect(device.id);
              setConnectedDevice(result.id);
              addLog(`Connected! Discovering services...`);
              const services = await discoverServices();
              for (const service of services) {
                const chars = await discoverCharacteristics(service.uuid);
                for (const char of chars) {
                  addLog(`  ....${char.suffix} [${char.properties}]`);
                }
              }
              addLog("Subscribing to 0003 + 0005...");
              try { await subscribe("0003"); addLog("  0003 subscribed"); } catch { addLog("  0003 failed"); }
              try { await subscribe("0005"); addLog("  0005 subscribed"); } catch { addLog("  0005 failed"); }
              addLog("Ready! Tap IMU Mode to send command.");
            } else {
              addLog("No connected straps. Scanning (5s)...");
              const results = await scan(WHOOP_SERVICES, 5);
              if (results.length > 0) {
                addLog(`Found ${results.length} — connecting to first...`);
                const result = await connect(results[0].id);
                setConnectedDevice(result.id);
                addLog(`Connected to ${result.name ?? "unnamed"}`);
              } else {
                addLog("No WHOOP straps found. Is the WHOOP app open?");
              }
            }
            break;
          }

          case "connect":
          case "c": {
            if (!args[0]) {
              addLog("Usage: connect <UUID>", "error");
              break;
            }
            addLog(`Connecting to ${args[0]}...`);
            const result = await connect(args[0]);
            setConnectedDevice(result.id);
            addLog(`Connected to ${result.name ?? "unnamed"} [${result.id}]`);
            break;
          }

          case "disconnect": {
            disconnect();
            setConnectedDevice(null);
            addLog("Disconnected");
            break;
          }

          case "discover":
          case "d": {
            addLog("Discovering services...");
            const services = await discoverServices();
            addLog(`Found ${services.length} services:`);
            for (const service of services) {
              addLog(`  ${service.uuid}`);
              addLog("  Discovering characteristics...");
              const chars = await discoverCharacteristics(service.uuid);
              for (const char of chars) {
                addLog(`    ....${char.suffix} [${char.properties}]`);
              }
            }
            break;
          }

          case "subscribe":
          case "sub":
          case "s": {
            if (!args[0]) {
              addLog("Usage: subscribe <suffix>", "error");
              break;
            }
            await subscribe(args[0]);
            addLog(`Subscribed to ....${args[0]}`);
            break;
          }

          case "write":
          case "w": {
            if (!args[0] || !args[1]) {
              addLog("Usage: write <suffix> <hex bytes>", "error");
              break;
            }
            const suffix = args[0];
            const hex = args.slice(1).join("");
            addLog(`Writing to ....${suffix}: ${hex}`);
            await writeRaw(suffix, hex);
            addLog("Write succeeded");
            break;
          }

          case "raw": {
            if (!args[0]) {
              addLog("Usage: raw <hex bytes> (writes to 0002 without response)", "error");
              break;
            }
            const hex = args.join("");
            addLog(`Writing to ....0002 (noResp): ${hex}`);
            await writeRaw("0002", hex, false);
            addLog("Write sent");
            break;
          }

          case "status": {
            addLog(`Connected: ${isConnected() ? connectedDevice : "no"}`);
            addLog(`Notifications received: ${notificationCount}`);
            break;
          }

          case "clear": {
            setLogs([]);
            setNotificationCount(0);
            break;
          }

          case "help":
          case "?": {
            addLog("Commands:");
            addLog("  scan              Scan for all BLE devices");
            addLog("  whoop             Find WHOOP straps");
            addLog("  connect <UUID>    Connect to device");
            addLog("  disconnect        Disconnect");
            addLog("  discover          Discover services + characteristics");
            addLog("  subscribe <sfx>   Subscribe to notifications");
            addLog("  write <sfx> <hex> Write hex bytes to characteristic");
            addLog("  raw <hex>         Write hex to CMD_TO_STRAP (0002)");
            addLog("  status            Connection status");
            addLog("  clear             Clear log");
            break;
          }

          default:
            addLog(`Unknown command: ${cmd}. Type 'help'.`, "error");
        }
      } catch (error) {
        addLog(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
    [addLog, connectedDevice, notificationCount],
  );

  const handleSubmit = useCallback(() => {
    executeCommand(commandInput);
    setCommandInput("");
  }, [commandInput, executeCommand]);

  const renderLogEntry = useCallback(
    ({ item }: { item: LogEntry }) => (
      <Text
        style={[
          styles.logText,
          item.type === "error" && styles.logError,
          item.type === "data" && styles.logData,
          item.type === "command" && styles.logCommand,
        ]}
        selectable
      >
        {item.text}
      </Text>
    ),
    [],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>BLE Probe</Text>
        <Text style={styles.subtitle}>
          {connectedDevice ? `Connected: ${connectedDevice.slice(0, 8)}...` : "Not connected"}
          {notificationCount > 0 ? ` | ${notificationCount} notifications` : ""}
        </Text>
      </View>

      <FlatList
        ref={flatListRef}
        data={logs}
        renderItem={renderLogEntry}
        keyExtractor={(item) => item.id}
        style={styles.logContainer}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
      />

      <View style={styles.quickButtons}>
        <Pressable style={styles.quickButton} onPress={() => executeCommand("whoop")}>
          <Text style={styles.quickButtonText}>WHOOP</Text>
        </Pressable>
        <Pressable style={styles.quickButton} onPress={() => executeCommand("discover")}>
          <Text style={styles.quickButtonText}>Discover</Text>
        </Pressable>
        <Pressable style={styles.quickButton} onPress={() => executeCommand("subscribe 0003")}>
          <Text style={styles.quickButtonText}>Sub 0003</Text>
        </Pressable>
        <Pressable style={styles.quickButton} onPress={() => executeCommand("subscribe 0005")}>
          <Text style={styles.quickButtonText}>Sub 0005</Text>
        </Pressable>
        <Pressable style={styles.quickButton} onPress={() => executeCommand("status")}>
          <Text style={styles.quickButtonText}>Status</Text>
        </Pressable>
      </View>
      <View style={styles.quickButtons}>
        <Pressable
          style={[styles.quickButton, { backgroundColor: "#2a3a2a" }]}
          onPress={() => executeCommand("raw aa010c000001e74123016a010100000081d31f98")}
        >
          <Text style={styles.quickButtonText}>IMU+CRC</Text>
        </Pressable>
        <Pressable
          style={[styles.quickButton, { backgroundColor: "#2a3a2a" }]}
          onPress={() => executeCommand("raw aa0104006a010100")}
        >
          <Text style={styles.quickButtonText}>IMU v2</Text>
        </Pressable>
        <Pressable
          style={[styles.quickButton, { backgroundColor: "#2a3a2a" }]}
          onPress={() => executeCommand("raw aa0102006a01")}
        >
          <Text style={styles.quickButtonText}>IMU v3</Text>
        </Pressable>
        <Pressable
          style={[styles.quickButton, { backgroundColor: "#2a3a2a" }]}
          onPress={() => executeCommand("raw aa0101006a")}
        >
          <Text style={styles.quickButtonText}>IMU v4</Text>
        </Pressable>
      </View>
      <View style={styles.quickButtons}>
        <Pressable
          style={[styles.quickButton, { backgroundColor: "#2a3a2a" }]}
          onPress={() => executeCommand("raw aa010100016a")}
        >
          <Text style={styles.quickButtonText}>IMU v5</Text>
        </Pressable>
        <Pressable
          style={[styles.quickButton, { backgroundColor: "#2a3a2a" }]}
          onPress={() => executeCommand("raw aa01020051016a0101000000")}
        >
          <Text style={styles.quickButtonText}>Start+IMU</Text>
        </Pressable>
        <Pressable style={styles.quickButton} onPress={() => executeCommand("status")}>
          <Text style={styles.quickButtonText}>Status</Text>
        </Pressable>
        <Pressable style={styles.quickButton} onPress={() => executeCommand("clear")}>
          <Text style={styles.quickButtonText}>Clear</Text>
        </Pressable>
      </View>

      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={commandInput}
          onChangeText={setCommandInput}
          placeholder="Type command..."
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={handleSubmit}
        />
        <Pressable style={styles.sendButton} onPress={handleSubmit}>
          <Text style={styles.sendButtonText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontFamily: fonts.bold,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontFamily: fonts.mono,
    marginTop: 2,
  },
  logContainer: {
    flex: 1,
    paddingHorizontal: spacing.sm,
  },
  logText: {
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    lineHeight: 18,
  },
  logError: {
    color: "#ff6b6b",
  },
  logData: {
    color: "#51cf66",
  },
  logCommand: {
    color: "#74c0fc",
  },
  quickButtons: {
    flexDirection: "row",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  quickButton: {
    backgroundColor: "#333",
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#555",
  },
  quickButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    fontFamily: fonts.mono,
  },
  inputContainer: {
    flexDirection: "row",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  input: {
    flex: 1,
    backgroundColor: colors.card,
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 14,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sendButton: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    justifyContent: "center",
  },
  sendButtonText: {
    color: "#fff",
    fontSize: 14,
    fontFamily: fonts.bold,
  },
});
