import { createElement, type ReactNode } from "react";
import { beforeEach, vi } from "vitest";

const asyncStorageValues = vi.hoisted(() => new Map<string, string>());
const secureStoreValues = vi.hoisted(() => new Map<string, string>());

// __DEV__ is a Metro compile-time global in React Native. Vitest cannot
// statically define it per-test, so expose it as a runtime global instead.
// Default to true (matching the React Native dev environment); tests that
// need to exercise production-only branches override it with vi.stubGlobal.
vi.stubGlobal("__DEV__", true);

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
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  setTag: vi.fn(),
  setExtra: vi.fn(),
}));

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => crypto.randomUUID()),
}));

vi.mock("posthog-react-native", () => ({
  __esModule: true,
  default: vi.fn().mockImplementation(() => ({
    captureException: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    register: vi.fn(),
  })),
}));

// Shared in-memory AsyncStorage mock for all mobile tests. Do not redeclare this
// mock in individual test files — rely on test-setup.ts and the beforeEach reset.
vi.mock("@react-native-async-storage/async-storage", () => {
  return {
    default: {
      getItem: vi.fn((key: string) => Promise.resolve(asyncStorageValues.get(key) ?? null)),
      setItem: vi.fn((key: string, value: string) => {
        asyncStorageValues.set(key, value);
        return Promise.resolve();
      }),
      removeItem: vi.fn((key: string) => {
        asyncStorageValues.delete(key);
        return Promise.resolve();
      }),
      clear: vi.fn(() => {
        asyncStorageValues.clear();
        return Promise.resolve();
      }),
      getAllKeys: vi.fn(() => Promise.resolve([...asyncStorageValues.keys()])),
      multiRemove: vi.fn((keys: string[]) => {
        for (const key of keys) asyncStorageValues.delete(key);
        return Promise.resolve();
      }),
    },
  };
});

beforeEach(() => {
  asyncStorageValues.clear();
  secureStoreValues.clear();
});

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

  function ariaPropsFromAccessibilityState(accessibilityState: unknown): Record<string, unknown> {
    if (typeof accessibilityState !== "object" || accessibilityState === null) {
      return {};
    }
    return {
      "aria-busy": "busy" in accessibilityState ? accessibilityState.busy : undefined,
      "aria-checked": "checked" in accessibilityState ? accessibilityState.checked : undefined,
      "aria-disabled": "disabled" in accessibilityState ? accessibilityState.disabled : undefined,
      "aria-expanded": "expanded" in accessibilityState ? accessibilityState.expanded : undefined,
      "aria-selected": "selected" in accessibilityState ? accessibilityState.selected : undefined,
    };
  }

  function createMockComponent(name: string) {
    const component = ({
      accessibilityHint,
      accessibilityLabel,
      accessibilityRole,
      accessible: _accessible,
      automaticallyAdjustKeyboardInsets,
      children,
      style,
      testID,
      ...props
    }: Record<string, unknown>) =>
      el(
        name,
        {
          ...props,
          "aria-description": accessibilityHint,
          "aria-label": accessibilityLabel,
          "data-automatically-adjust-keyboard-insets": automaticallyAdjustKeyboardInsets,
          "data-testid": testID,
          role: accessibilityRole,
          style: flattenStyle(style),
        },
        children,
      );
    component.displayName = name;
    return component;
  }

  const View = createMockComponent("View");
  const Text = createMockComponent("Text");
  const ScrollView = createMockComponent("ScrollView");
  const Pressable = ({
    accessibilityState,
    children,
    onPress,
    onPressIn,
    onPressOut,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
    style,
    ...props
  }: Record<string, unknown>) => {
    const pressActiveRef = React.useRef(false);

    const beginPress = (event: unknown) => {
      pressActiveRef.current = true;
      if (typeof onPressIn === "function") {
        onPressIn(event);
      }
    };
    const endPress = (event: unknown) => {
      if (!pressActiveRef.current) {
        return;
      }

      pressActiveRef.current = false;
      if (typeof onPressOut === "function") {
        onPressOut(event);
      }
    };

    return React.createElement(
      "button",
      {
        ...props,
        ...ariaPropsFromAccessibilityState(accessibilityState),
        onClick: onPress,
        onMouseDown: beginPress,
        onMouseLeave: endPress,
        onMouseUp: endPress,
        role: accessibilityRole ?? "presentation",
        "aria-label": accessibilityLabel,
        "aria-description": accessibilityHint,
        style: flattenStyle(style),
        type: "button",
      },
      children,
    );
  };
  Pressable.displayName = "Pressable";
  const TextInput = ({
    accessibilityLabel,
    "aria-label": ariaLabel,
    multiline,
    numberOfLines: _numberOfLines,
    onChangeText,
    placeholderTextColor: _placeholderTextColor,
    secureTextEntry,
    style,
    textAlignVertical: _textAlignVertical,
    testID,
    value,
    ...props
  }: Record<string, unknown>) => {
    const tagName = multiline === true ? "textarea" : "input";
    return React.createElement(tagName, {
      ...props,
      "aria-label": accessibilityLabel ?? ariaLabel,
      "data-testid": testID,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (typeof onChangeText === "function") onChangeText(event.target.value);
      },
      style: flattenStyle(style),
      ...(multiline === true ? {} : { type: secureTextEntry === true ? "password" : "text" }),
      value,
    });
  };
  TextInput.displayName = "TextInput";
  const Image = ({
    accessibilityLabel,
    children,
    onError,
    style,
    testID,
    ...props
  }: Record<string, unknown>) =>
    React.createElement(
      "image",
      {
        ...props,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        onError,
        style: flattenStyle(style),
      },
      children,
    );
  Image.displayName = "Image";
  const FlatList = createMockComponent("FlatList");
  const Modal = createMockComponent("Modal");
  const ActivityIndicator = ({ color, style, ...props }: Record<string, unknown>) =>
    React.createElement("activityindicator", {
      ...props,
      style: flattenStyle(style),
      color,
      role: "progressbar",
    });
  ActivityIndicator.displayName = "ActivityIndicator";

  const TouchableOpacity = ({
    accessibilityHint,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    onPress,
    style,
    ...props
  }: Record<string, unknown>) =>
    el(
      "button",
      {
        ...props,
        ...ariaPropsFromAccessibilityState(accessibilityState),
        "aria-description": accessibilityHint,
        "aria-label": accessibilityLabel,
        onClick: onPress,
        role: accessibilityRole ?? "presentation",
        style: flattenStyle(style),
        type: "button",
      },
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
  const AccessibilityInfo = { announceForAccessibility: vi.fn() };
  const Linking = { openURL: vi.fn(() => Promise.resolve()) };
  const Share = { share: vi.fn(() => Promise.resolve({ action: "sharedAction" })) };

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

  const LayoutAnimation = {
    configureNext: vi.fn(),
    Presets: {
      easeInEaseOut: {},
      linear: {},
      spring: {},
    },
  };

  const UIManager = {
    setLayoutAnimationEnabledExperimental: vi.fn(),
  };

  const DynamicColorIOS = vi.fn((variants: { light: string; dark: string }) => variants);

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
    Modal,
    ActivityIndicator,
    RefreshControl,
    Switch,
    StyleSheet,
    Platform,
    Alert,
    AccessibilityInfo,
    Linking,
    Share,
    AppState,
    LayoutAnimation,
    UIManager,
    DynamicColorIOS,
    useWindowDimensions: vi.fn(() => ({
      width: 390,
      height: 844,
      scale: 3,
      fontScale: 1,
    })),
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
    Polygon: svgComponent("Polygon"),
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
      View: ({
        children,
        entering,
        exiting,
        layout,
        style,
        testID,
        ...props
      }: Record<string, unknown>) => {
        // Strip reanimated-specific props and animated style objects
        const plainStyle = Array.isArray(style)
          ? Object.assign({}, ...style.map((s: unknown) => (typeof s === "object" && s ? s : {})))
          : typeof style === "object" && style
            ? style
            : undefined;
        return React.createElement(
          "div",
          { ...props, style: plainStyle, "data-testid": testID },
          children,
        );
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
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStoreValues.set(key, value);
    return Promise.resolve();
  }),
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStoreValues.get(key) ?? null)),
  deleteItemAsync: vi.fn((key: string) => {
    secureStoreValues.delete(key);
    return Promise.resolve();
  }),
  AFTER_FIRST_UNLOCK: "kSecAttrAccessibleAfterFirstUnlock",
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

vi.mock("expo-haptics", () => ({
  selectionAsync: vi.fn(() => Promise.resolve()),
  impactAsync: vi.fn(() => Promise.resolve()),
  notificationAsync: vi.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

// ── HealthKit native module mock ─────────────────────────────────────
vi.mock("./modules/health-kit", async () => {
  const { createEmptyAnchoredQueryResult } = await import("./modules/health-kit/test-helpers");
  return {
    completeAnchoredQuery: vi.fn(() => Promise.resolve(true)),
    getRequestStatus: vi.fn(() => Promise.resolve("shouldRequest")),
    hasEverAuthorized: vi.fn(() => false),
    isAvailable: vi.fn(() => true),
    isBackgroundDeliveryEnabled: vi.fn(() => false),
    queryAnchoredSamples: vi.fn(() => Promise.resolve(createEmptyAnchoredQueryResult())),
    requestPermissions: vi.fn(() => Promise.resolve(true)),
    requestAuthorization: vi.fn(() => Promise.resolve(true)),
    queryDailyStatistics: vi.fn(() => Promise.resolve([])),
    queryCategorySamples: vi.fn(() => Promise.resolve([])),
    queryQuantitySamples: vi.fn(() => Promise.resolve([])),
    queryWorkouts: vi.fn(() => Promise.resolve([])),
    queryWorkoutRoutes: vi.fn(() => Promise.resolve([])),
    querySleepSamples: vi.fn(() => Promise.resolve([])),
    queryHeartRateSamples: vi.fn(() => Promise.resolve([])),
    deleteDietarySamples: vi.fn(() => Promise.resolve(0)),
    purgeAccountState: vi.fn(() => Promise.resolve(true)),
  };
});

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
  purgeAccountState: vi.fn(),
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

vi.mock("expo-notifications", () => ({
  SchedulableTriggerInputTypes: {
    DAILY: "daily",
  },
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  cancelScheduledNotificationAsync: vi.fn(async () => undefined),
  getAllScheduledNotificationsAsync: vi.fn(async () => []),
  getLastNotificationResponse: vi.fn(() => null),
  getPermissionsAsync: vi.fn(async () => ({ status: "undetermined" })),
  requestPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
  scheduleNotificationAsync: vi.fn(async () => "notification-id"),
  setNotificationHandler: vi.fn(),
}));

// ── WHOOP BLE native module mock ───────────────────────────────────
vi.mock("./modules/whoop-ble", () => ({
  isBluetoothAvailable: vi.fn(() => false),
  findWhoop: vi.fn(() => Promise.resolve(null)),
  connect: vi.fn(() => Promise.resolve(false)),
  startImuStreaming: vi.fn(() => Promise.resolve(false)),
  stopImuStreaming: vi.fn(() => Promise.resolve(false)),
  peekBufferedSamples: vi.fn(() => Promise.resolve([])),
  confirmSamplesDrain: vi.fn(),
  peekBufferedRealtimeData: vi.fn(() => Promise.resolve([])),
  confirmRealtimeDataDrain: vi.fn(),
  getBufferedSamples: vi.fn(() => Promise.resolve([])),
  getBufferedRealtimeData: vi.fn(() => Promise.resolve([])),
  addConnectionStateListener: vi.fn(() => ({ remove: vi.fn() })),
  disconnect: vi.fn(),
  purgeAccountState: vi.fn(),
}));

// ── BLE heart-rate native module mock ──────────────────────────────
vi.mock("./modules/ble-heart-rate", () => ({
  isBluetoothAvailable: vi.fn(() => false),
  scanAndConnect: vi.fn(() => Promise.resolve({ id: "mock-device", name: "Mock HR" })),
  connect: vi.fn(() => Promise.resolve({ id: "mock-device", name: "Mock HR" })),
  getConnectionState: vi.fn(() => "idle"),
  getBufferedSampleCount: vi.fn(() => 0),
  peekBufferedSamples: vi.fn(() => Promise.resolve([])),
  confirmSamplesDrain: vi.fn(),
  disconnectAndClearBufferedSamples: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
  addConnectionStateListener: vi.fn(() => ({ remove: vi.fn() })),
  addHeartRateListener: vi.fn(() => ({ remove: vi.fn() })),
  purgeAccountState: vi.fn(),
}));

// ── React Native Maps mock ──────────────────────────────────────────
vi.mock("react-native-maps", () => {
  const React = require("react");
  function mapComponent(name: string) {
    const component = ({ children, testID, ...props }: Record<string, unknown>) =>
      React.createElement(name, { ...props, "data-testid": testID }, children);
    component.displayName = name;
    return component;
  }
  const MapView = mapComponent("MapView");
  const Polyline = mapComponent("Polyline");
  const Marker = mapComponent("Marker");
  return {
    __esModule: true,
    default: MapView,
    Polyline,
    Marker,
  };
});

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
  getPendingWatchFileNames: vi.fn(() => []),
  getPendingWatchAltitudeFileNames: vi.fn(() => []),
  readWatchFile: vi.fn(() => Promise.resolve([])),
  readWatchAltitudeFile: vi.fn(() => Promise.resolve([])),
  deleteWatchFile: vi.fn(),
  purgeAccountState: vi.fn(() => Promise.resolve(true)),
}));
