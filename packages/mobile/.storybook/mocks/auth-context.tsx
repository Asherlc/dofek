import { createContext, type ReactNode, useContext } from "react";

interface AuthState {
  user: { id: string; name: string; email: string | null } | null;
  serverUrl: string;
  isLoading: false;
  sessionToken: null;
  beginAccountErasureCleanup: (ownerUserId: string) => {
    cleanupId: number;
    cleanupOwnerNonce: string;
    sessionGeneration: number;
  };
  finishAccountErasureCleanup: () => void;
  isAccountErasureCleanupLeaseCurrent: () => boolean;
  onLoginSuccess: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

interface StorybookAuthOverrides {
  beginAccountErasureCleanup?: AuthState["beginAccountErasureCleanup"];
  user?: AuthState["user"];
}

declare global {
  var __dofekStorybookAuth: StorybookAuthOverrides | undefined;
}

const MOCK_AUTH: AuthState = {
  user: null,
  serverUrl: "https://storybook.example.com",
  isLoading: false,
  sessionToken: null,
  beginAccountErasureCleanup: () => ({
    cleanupId: 1,
    cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
    sessionGeneration: 1,
  }),
  finishAccountErasureCleanup: () => {},
  isAccountErasureCleanupLeaseCurrent: () => true,
  onLoginSuccess: async () => {},
  logout: async () => {},
};

const MockAuthContext = createContext<AuthState>(MOCK_AUTH);

export function AuthProvider({ children }: { children: ReactNode }) {
  return <MockAuthContext.Provider value={MOCK_AUTH}>{children}</MockAuthContext.Provider>;
}

export function useAuth(): AuthState {
  return { ...useContext(MockAuthContext), ...globalThis.__dofekStorybookAuth };
}
