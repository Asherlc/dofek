import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  type AuthUser,
  clearSessionToken,
  fetchCurrentUser,
  getSessionToken,
  logout as authLogout,
  saveSessionToken,
} from "./auth";
import { getServerUrl, saveServerUrl, clearServerUrl } from "./server";

interface AuthState {
  /** The authenticated user, or null if not logged in. */
  user: AuthUser | null;
  /** The configured server URL, or null if not set up. */
  serverUrl: string | null;
  /** True while loading auth state from secure storage. */
  isLoading: boolean;
  /** The session token (for passing to tRPC). */
  sessionToken: string | null;
  /** Set the server URL (first-time setup). */
  setServer: (url: string) => Promise<void>;
  /** Called after successful OAuth — stores the session token and fetches the user. */
  onLoginSuccess: (token: string) => Promise<void>;
  /** Log out and clear session. */
  logout: () => Promise<void>;
  /** Disconnect from server (clears URL and token). */
  disconnectServer: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [serverUrl, setServerUrlState] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On mount, restore auth state from secure storage
  useEffect(() => {
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) {
          setIsLoading(false);
          return;
        }
        setServerUrlState(url);

        const token = await getSessionToken();
        if (!token) {
          setIsLoading(false);
          return;
        }

        const currentUser = await fetchCurrentUser(url, token);
        if (currentUser) {
          setSessionToken(token);
          setUser(currentUser);
        } else {
          // Token expired — clear it
          await clearSessionToken();
        }
      } catch {
        // Ignore errors during restore
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const setServer = useCallback(async (url: string) => {
    await saveServerUrl(url);
    setServerUrlState(url);
  }, []);

  const onLoginSuccess = useCallback(
    async (token: string) => {
      await saveSessionToken(token);
      setSessionToken(token);

      if (serverUrl) {
        const currentUser = await fetchCurrentUser(serverUrl, token);
        setUser(currentUser);
      }
    },
    [serverUrl],
  );

  const logout = useCallback(async () => {
    if (serverUrl && sessionToken) {
      await authLogout(serverUrl, sessionToken);
    } else {
      await clearSessionToken();
    }
    setSessionToken(null);
    setUser(null);
  }, [serverUrl, sessionToken]);

  const disconnectServer = useCallback(async () => {
    if (serverUrl && sessionToken) {
      await authLogout(serverUrl, sessionToken);
    } else {
      await clearSessionToken();
    }
    await clearServerUrl();
    setSessionToken(null);
    setUser(null);
    setServerUrlState(null);
  }, [serverUrl, sessionToken]);

  const value = useMemo(
    () => ({
      user,
      serverUrl,
      isLoading,
      sessionToken,
      setServer,
      onLoginSuccess,
      logout,
      disconnectServer,
    }),
    [user, serverUrl, isLoading, sessionToken, setServer, onLoginSuccess, logout, disconnectServer],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
