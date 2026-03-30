import { createElement, type ReactNode } from "react";
import { vi } from "vitest";

// Suppress React DOM warnings about unknown elements (View, Text, etc.)
// since we render RN component names as HTML tags in the mock.
const originalError = console.error;
console.error = (...args: unknown[]) => {
  const msg = typeof args[0] === "string" ? args[0] : "";
  if (
    msg.includes("is using incorrect casing") ||
    msg.includes("is unrecognized in this browser") ||
    msg.includes("React does not recognize the")
  ) {
    return;
  }
  originalError.call(console, ...args);
};

// ── Sentry React Native mock ─────────────────────────────────────────
// @sentry/react-native internally requires react-native/Libraries/Promise
// (a sub-path not covered by the react-native mock below). Mocking
// the whole package avoids loading real react-native internals.
vi.mock("@sentry/react-native", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  setTag: vi.fn(),
  setExtra: vi.fn(),
}));

// ── React Native mock ────────────────────────────────────────────────
// react-native uses Flow syntax that Vitest can't parse. Provide minimal
// component implementations backed by plain React elements.
vi.mock("react-native", () => {
  const React = require("react");

  // Flatten RN-style arrays like style={[styles.a, { color: "red" }]}
  // into a single object for DOM compatibility.
  function flattenStyle(style: unknown): Record<string, unknown> | undefined {
    if (style == null) return undefined;
    if (Array.isArray(style)) {
      return Object.assign({}, ...style.map(flattenStyle));
    }
    if (typeof style === "object" && !Array.isArray(style)) return style;
    return undefined;
  }

  function el(tag: string, props: Record<string, unknown>, children?: unknown) {
    return React.createElement(tag, props, ...(children != null ? [children] : []));
  }

  function createMockComponent(name: string) {
    const component = ({ children, style, testID, ...props }: Record<string, unknown>) =>
      el(name, { ...props, style: flattenStyle(style), "data-testid": testID }, children);
    component.displayName = name;
    return component;
  }

  const View = createMockComponent("View");
  const Text = createMockComponent("Text");
  const ScrollView = createMockComponent("ScrollView");
  const Pressable = ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
    style,
    ...props
  }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        ...props,
        onClick: onPress,
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "aria-description": accessibilityHint,
        style: flattenStyle(style),
        type: "button",
      },
      children,
    );
  Pressable.displayName = "Pressable";
  const TextInput = createMockComponent("TextInput");
  const Image = createMockComponent("Image");
  const FlatList = createMockComponent("FlatList");
  const ActivityIndicator = ({ color, style, ...props }: Record<string, unknown>) =>
    React.createElement("activityindicator", {
      ...props,
      style: flattenStyle(style),
      color,
      role: "progressbar",
    });
  ActivityIndicator.displayName = "ActivityIndicator";

  const TouchableOpacity = ({ children, onPress, style, ...props }: Record<string, unknown>) =>
    el(
      "button",
      { ...props, onClick: onPress, style: flattenStyle(style), type: "button" },
      children,
    );
  TouchableOpacity.displayName = "TouchableOpacity";

  // Strip RN-specific style values (arrays like fontVariant) that
  // React DOM's setValueForStyle doesn't understand.
  function sanitizeStyles(styles: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(styles)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        result[key] = sanitizeStyles(Object.fromEntries(Object.entries(value)));
      } else if (Array.isArray(value)) {
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  const StyleSheet = {
    create: <T extends Record<string, Record<string, unknown>>>(styles: T): T => {
      for (const key of Object.keys(styles)) {
        const sanitized = sanitizeStyles(styles[key]);
        for (const prop of Object.keys(styles[key])) {
          delete styles[key][prop];
        }
        Object.assign(styles[key], sanitized);
      }
      return styles;
    },
    flatten: (style: unknown) => style,
  };

  const Platform = {
    OS: "ios",
    select: (obj: Record<string, unknown>) => obj.ios ?? obj.default,
  };

  const Alert = { alert: vi.fn() };

  const RefreshControl = createMockComponent("RefreshControl");

  const Switch = ({ value, onValueChange, disabled, ...props }: Record<string, unknown>) =>
    React.createElement("input", {
      ...props,
      type: "checkbox",
      checked: value,
      onChange: () => {
        if (!disabled && typeof onValueChange === "function") onValueChange(!value);
      },
      disabled,
    });
  Switch.displayName = "Switch";

  const AppState = {
    currentState: String("active"),
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    removeEventListener: vi.fn(),
  };

  return {
    __esModule: true,
    View,
    Text,
    ScrollView,
    TouchableOpacity,
    Pressable,
    TextInput,
    Image,
    FlatList,
    ActivityIndicator,
    RefreshControl,
    Switch,
    StyleSheet,
    Platform,
    Alert,
    AppState,
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

// ── React Native SVG mock ────────────────────────────────────────────
vi.mock("react-native-svg", () => {
  const React = require("react");

  function svgComponent(name: string) {
    const component = ({ children, ...props }: Record<string, unknown>) =>
      React.createElement(name, props, ...(children != null ? [children] : []));
    component.displayName = name;
    return component;
  }

  return {
    __esModule: true,
    default: svgComponent("Svg"),
    Svg: svgComponent("Svg"),
    SvgXml: svgComponent("SvgXml"),
    Circle: svgComponent("Circle"),
    Line: svgComponent("Line"),
    Polyline: svgComponent("Polyline"),
    Rect: svgComponent("Rect"),
    Path: svgComponent("Path"),
    G: svgComponent("G"),
    Text: svgComponent("SvgText"),
    Defs: svgComponent("Defs"),
    LinearGradient: svgComponent("LinearGradient"),
    Stop: svgComponent("Stop"),
  };
});

// ── React Native Reanimated mock ─────────────────────────────────────
vi.mock("react-native-reanimated", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (component: unknown) => component,
      View: ({ children, entering, exiting, layout, style, testID, ...props }: Record<string, unknown>) => {
        // Strip reanimated-specific props and animated style objects
        const plainStyle = Array.isArray(style)
          ? Object.assign({}, ...style.map((s: unknown) => (typeof s === "object" && s ? s : {})))
          : typeof style === "object" && style
            ? style
            : undefined;
        return React.createElement("div", { ...props, style: plainStyle, "data-testid": testID }, children);
      },
    },
    useSharedValue: (initial: unknown) => ({ value: initial }),
    useAnimatedProps: (updater: () => Record<string, unknown>) => updater(),
    useAnimatedStyle: (updater: () => Record<string, unknown>) => updater(),
    withTiming: (toValue: unknown) => toValue,
    withDelay: (_delay: number, animation: unknown) => animation,
    withRepeat: (animation: unknown) => animation,
    withSpring: (toValue: unknown) => toValue,
    withCallback: (_callback: unknown, animation: unknown) => animation,
    Easing: {
      bezier: () => ({}),
      linear: {},
      ease: {},
      out: () => ({}),
      in: () => ({}),
      inOut: () => ({}),
    },
    FadeIn: { delay: () => ({ duration: () => ({ easing: () => ({}) }) }) },
    FadeInUp: { delay: () => ({ duration: () => ({ easing: () => ({}) }) }) },
    FadeOut: {},
    SlideInRight: {},
    Layout: { duration: () => ({}) },
    createAnimatedComponent: (component: unknown) => component,
    runOnJS: (fn: (...args: unknown[]) => void) => fn,
  };
});

// ── React Native Safe Area mock ──────────────────────────────────────
vi.mock("react-native-safe-area-context", () => {
  const React = require("react");
  return {
    SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
    SafeAreaView: ({ children, ...props }: Record<string, unknown>) =>
      React.createElement("SafeAreaView", props, ...(children != null ? [children] : [])),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// ── React Native Screens mock ────────────────────────────────────────
vi.mock("react-native-screens", () => ({}));

// ── Expo module mocks ────────────────────────────────────────────────
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(() => Promise.resolve(null)),
  deleteItemAsync: vi.fn(),
}));

vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(() => Promise.resolve({ type: "cancel" })),
  WebBrowserPresentationStyle: { PAGE_SHEET: "pageSheet" },
  WebBrowserResultType: { CANCEL: "cancel", DISMISS: "dismiss", OPENED: "opened" },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
  }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
  Stack: ({ children }: { children: ReactNode }) => createElement("Stack", null, children),
  Tabs: ({ children }: { children: ReactNode }) => createElement("Tabs", null, children),
  Link: ({ children }: { children: ReactNode }) => createElement("Link", null, children),
}));

vi.mock("expo-apple-authentication", () => ({
  isAvailableAsync: vi.fn(() => Promise.resolve(true)),
  signInAsync: vi.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  AppleAuthenticationButtonStyle: { WHITE: 0 },
}));

vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: false }, vi.fn()],
}));

vi.mock("expo-status-bar", () => ({
  StatusBar: () => null,
}));

vi.mock("expo-haptics", () => ({
  selectionAsync: vi.fn(() => Promise.resolve()),
  impactAsync: vi.fn(() => Promise.resolve()),
  notificationAsync: vi.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

// ── HealthKit native module mock ─────────────────────────────────────
vi.mock("./modules/health-kit", () => ({
  getRequestStatus: vi.fn(() => Promise.resolve("shouldRequest")),
  isBackgroundDeliveryEnabled: vi.fn(() => false),
  requestAuthorization: vi.fn(() => Promise.resolve(true)),
  queryWorkouts: vi.fn(() => Promise.resolve([])),
  querySleepSamples: vi.fn(() => Promise.resolve([])),
  queryHeartRateSamples: vi.fn(() => Promise.resolve([])),
}));

// ── CoreMotion native module mock ───────────────────────────────────
vi.mock("./modules/core-motion", () => ({
  isAccelerometerRecordingAvailable: vi.fn(() => false),
  getMotionAuthorizationStatus: vi.fn(() => "notDetermined"),
  requestMotionPermission: vi.fn(() => Promise.resolve("authorized")),
  startRecording: vi.fn(() => Promise.resolve(true)),
  isRecordingActive: vi.fn(() => false),
  queryRecordedData: vi.fn(() => Promise.resolve([])),
  getLastSyncTimestamp: vi.fn(() => null),
  setLastSyncTimestamp: vi.fn(),
}));

// ── Background Refresh native module mock ──────────────────────────
vi.mock("./modules/background-refresh", () => ({
  scheduleRefresh: vi.fn(),
  isBackgroundRefreshAvailable: vi.fn(() => false),
  addBackgroundRefreshListener: vi.fn(() => ({ remove: vi.fn() })),
}));

// ── expo-updates mock ─────────────────────────────────────────────
vi.mock("expo-updates", () => ({
  updateId: null,
  channel: null,
  runtimeVersion: null,
  createdAt: null,
  isEmbeddedLaunch: true,
}));

// ── WHOOP BLE native module mock ───────────────────────────────────
vi.mock("./modules/whoop-ble", () => ({
  isBluetoothAvailable: vi.fn(() => false),
  findWhoop: vi.fn(() => Promise.resolve(null)),
  connect: vi.fn(() => Promise.resolve(false)),
  startImuStreaming: vi.fn(() => Promise.resolve(false)),
  stopImuStreaming: vi.fn(() => Promise.resolve(false)),
  getBufferedSamples: vi.fn(() => Promise.resolve([])),
  disconnect: vi.fn(),
}));

// ── Watch Motion native module mock ─────────────────────────────────
vi.mock("./modules/watch-motion", () => ({
  isWatchSupported: vi.fn(() => true),
  isWatchPaired: vi.fn(() => false),
  isWatchAppInstalled: vi.fn(() => false),
  getWatchSyncStatus: vi.fn(() => ({
    isSupported: true,
    isPaired: false,
    isReachable: false,
    isWatchAppInstalled: false,
    pendingFileCount: 0,
  })),
  requestWatchSync: vi.fn(() => Promise.resolve(false)),
  requestWatchRecording: vi.fn(() => Promise.resolve(false)),
  getPendingWatchSamples: vi.fn(() => Promise.resolve([])),
  acknowledgeWatchSamples: vi.fn(),
  getLastWatchSyncTimestamp: vi.fn(() => null),
  setLastWatchSyncTimestamp: vi.fn(),
}));
