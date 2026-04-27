import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type AuthUser,
  logout as authLogout,
  clearSessionToken,
  fetchCurrentUser,
  getSessionToken,
  saveSessionToken,
} from "./auth";
import { SERVER_URL } from "./server";
import { captureException } from "./telemetry";

interface AuthState {
  /** The authenticated user, or null if not logged in. */
  user: AuthUser | null;
  /** The server URL (always the production server). */
  serverUrl: string;
  /** True while loading auth state from secure storage. */
  isLoading: boolean;
  /** The session token (for passing to tRPC). */
  sessionToken: string | null;
  /** Called after successful OAuth — stores the session token and fetches the user. */
  onLoginSuccess: (token: string) => Promise<void>;
  /** Log out and clear session. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On mount, restore auth state from secure storage
  useEffect(() => {
    (async () => {
      try {
        const token = await getSessionToken();
        if (!token) {
          setIsLoading(false);
          return;
        }

        const currentUser = await fetchCurrentUser(SERVER_URL, token);
        if (currentUser) {
          setSessionToken(token);
          setUser(currentUser);
        } else {
          // Token expired — clear it
          await clearSessionToken();
        }
      } catch (error: unknown) {
        captureException(error, { source: "auth-state-restore" });
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const onLoginSuccess = useCallback(async (token: string) => {
    await saveSessionToken(token);
    setSessionToken(token);

    const currentUser = await fetchCurrentUser(SERVER_URL, token);
    setUser(currentUser);
  }, []);

  const logout = useCallback(async () => {
    // Clear React state immediately so the UI shows the login screen
    setSessionToken(null);
    setUser(null);

    // Async cleanup: notify server and clear secure storage
    try {
      if (sessionToken) {
        await authLogout(SERVER_URL, sessionToken);
      } else {
        await clearSessionToken();
      }
    } catch (error: unknown) {
      captureException(error, { source: "logout" });
    }
  }, [sessionToken]);

  const value = useMemo(
    () => ({
      user,
      serverUrl: SERVER_URL,
      isLoading,
      sessionToken,
      onLoginSuccess,
      logout,
    }),
    [user, isLoading, sessionToken, onLoginSuccess, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
