import * as React from "react";

type RouterMethod = (href?: string) => void;

const noopRouterMethod: RouterMethod = () => {};

export const router = {
  back: noopRouterMethod,
  canGoBack: () => false,
  dismiss: noopRouterMethod,
  dismissAll: noopRouterMethod,
  navigate: noopRouterMethod,
  push: noopRouterMethod,
  replace: noopRouterMethod,
  setParams: () => {},
};

export function useRouter() {
  return router;
}

export function useLocalSearchParams(): Record<string, string | string[] | undefined> {
  return {};
}

function Navigator({ children }: { children?: React.ReactNode }) {
  return React.createElement(React.Fragment, null, children);
}

function Screen() {
  return null;
}

export const Stack = Object.assign(Navigator, { Screen });
export const Tabs = Object.assign(Navigator, { Screen });
export const Slot = Navigator;

export function Link({ children }: { children?: React.ReactNode }) {
  return React.createElement(React.Fragment, null, children);
}

export default router;
