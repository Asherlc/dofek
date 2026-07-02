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
import { removeMobileQueryCache } from "./mobile-query-persistence";
import { SERVER_URL } from "./server";
import { captureException } from "./telemetry";

interface AuthState {
  /** The authenticated user, or null if not logged in. */
  user: AuthUser | null;
  /** The server URL (always the production server). */
  serverUrl: string;
  /** True while loading auth state from secure storage. */
  isLoading: boolean;
  /** Real auth bootstrap failure, distinct from no saved session. */
  bootstrapError: string | null;
  /** The session token (for passing to tRPC). */
  sessionToken: string | null;
  /** Called after successful OAuth — stores the session token and fetches the user. */
  onLoginSuccess: (token: string) => Promise<void>;
  /** Log out and clear session. */
  logout: () => Promise<void>;
  /** Retry auth bootstrap after a transient restore failure. */
  retryBootstrap: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const retryBootstrap = useCallback(async () => {
    setIsLoading(true);
    try {
      const token = await getSessionToken();
      if (!token) {
        setUser(null);
        setSessionToken(null);
        setBootstrapError(null);
        return;
      }

      // Re-save to migrate existing tokens to AFTER_FIRST_UNLOCK accessibility
      // so they remain readable when the app runs in the background while locked.
      await saveSessionToken(token);
      setSessionToken(token);

      const currentUser = await fetchCurrentUser(SERVER_URL, token);
      if (currentUser) {
        setUser(currentUser);
        setBootstrapError(null);
      } else {
        await clearSessionToken();
        setUser(null);
        setSessionToken(null);
        setBootstrapError(null);
      }
    } catch (error: unknown) {
      captureException(error, { source: "auth-state-restore" });
      setUser(null);
      setBootstrapError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // On mount, restore auth state from secure storage.
  useEffect(() => {
    void retryBootstrap();
  }, [retryBootstrap]);

  const onLoginSuccess = useCallback(async (token: string) => {
    await saveSessionToken(token);
    setSessionToken(token);

    const currentUser = await fetchCurrentUser(SERVER_URL, token);
    setUser(currentUser);
    setBootstrapError(null);
  }, []);

  const logout = useCallback(async () => {
    const currentUserId = user?.id;
    // Clear React state immediately so the UI shows the login screen
    setSessionToken(null);
    setUser(null);
    setBootstrapError(null);

    // Async cleanup: notify server and clear secure storage
    try {
      if (currentUserId) {
        await removeMobileQueryCache(currentUserId);
      }
      if (sessionToken) {
        await authLogout(SERVER_URL, sessionToken);
      } else {
        await clearSessionToken();
      }
    } catch (error: unknown) {
      captureException(error, { source: "logout" });
    }
  }, [sessionToken, user?.id]);

  const value = useMemo(
    () => ({
      user,
      serverUrl: SERVER_URL,
      isLoading,
      bootstrapError,
      sessionToken,
      onLoginSuccess,
      logout,
      retryBootstrap,
    }),
    [user, isLoading, bootstrapError, sessionToken, onLoginSuccess, logout, retryBootstrap],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
