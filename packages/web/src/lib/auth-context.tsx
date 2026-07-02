import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { AuthUser } from "./auth.ts";
import { logout as doLogout, fetchCurrentUser } from "./auth.ts";
import { removeWebQueryCache } from "./query-persistence.ts";
import { captureException } from "./telemetry.ts";

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  bootstrapError: string | null;
  logout: () => Promise<void>;
  retryBootstrap: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  bootstrapError: null,
  logout: doLogout,
  retryBootstrap: async () => undefined,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const retryBootstrap = useCallback(async () => {
    setIsLoading(true);
    try {
      const currentUser = await fetchCurrentUser();
      setBootstrapError(null);
      setUser(currentUser);
    } catch (error: unknown) {
      captureException(error, { source: "auth-bootstrap" });
      setBootstrapError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void retryBootstrap();
  }, [retryBootstrap]);

  const logout = useCallback(async () => {
    const currentUserId = user?.id;
    setUser(null);
    setBootstrapError(null);
    if (currentUserId) removeWebQueryCache(currentUserId);
    try {
      await doLogout();
    } catch (error: unknown) {
      captureException(error, { source: "logout" });
      throw error;
    }
  }, [user?.id]);

  return (
    <AuthContext.Provider value={{ user, isLoading, bootstrapError, logout, retryBootstrap }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
