import { createContext, type ReactNode, useContext } from "react";

interface AuthState {
  user: null;
  serverUrl: string;
  isLoading: false;
  sessionToken: null;
  onLoginSuccess: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const MOCK_AUTH: AuthState = {
  user: null,
  serverUrl: "https://storybook.example.com",
  isLoading: false,
  sessionToken: null,
  onLoginSuccess: async () => {},
  logout: async () => {},
};

const MockAuthContext = createContext<AuthState>(MOCK_AUTH);

export function AuthProvider({ children }: { children: ReactNode }) {
  return <MockAuthContext.Provider value={MOCK_AUTH}>{children}</MockAuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(MockAuthContext);
}
