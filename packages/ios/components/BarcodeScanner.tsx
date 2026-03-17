import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef } from "react";
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";

interface BarcodeScannerProps {
  onScanned: (barcode: string) => void;
  onClose: () => void;
}

export function BarcodeScanner({ onScanned, onClose }: BarcodeScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);
  const { width, height } = useWindowDimensions();
  const scanSize = Math.min(width, height) * 0.65;

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionCard}>
          <Text style={styles.permissionText}>Camera access is needed to scan barcodes.</Text>
          <TouchableOpacity style={styles.button} onPress={requestPermission} activeOpacity={0.7}>
            <Text style={styles.buttonText}>Grant Camera Access</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelButton} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39"],
        }}
        onBarcodeScanned={(result) => {
          if (scannedRef.current) return;
          scannedRef.current = true;
          onScanned(result.data);
        }}
      />

      {/* Scan overlay */}
      <View style={styles.overlay}>
        <View style={styles.overlayTop} />
        <View style={[styles.overlayMiddle, { height: scanSize }]}>
          <View style={styles.overlaySide} />
          <View style={[styles.scanArea, { width: scanSize, height: scanSize }]}>
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />
          </View>
          <View style={styles.overlaySide} />
        </View>
        <View style={styles.overlayBottom}>
          <Text style={styles.instructionText}>Point at a barcode</Text>
          <TouchableOpacity style={styles.closeButton} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    zIndex: 100,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  overlayTop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  overlayMiddle: {
    flexDirection: "row",
  },
  overlaySide: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  scanArea: {},
  overlayBottom: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    paddingTop: 24,
  },
  corner: {
    position: "absolute",
    width: 24,
    height: 24,
    borderColor: "#fff",
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
  },
  instructionText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "500",
  },
  closeButton: {
    marginTop: 24,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  closeButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  permissionCard: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  permissionText: {
    color: "#fff",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 24,
  },
  button: {
    backgroundColor: "#007AFF",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  cancelButton: {
    padding: 12,
  },
  cancelText: {
    color: "#999",
    fontSize: 16,
  },
});
