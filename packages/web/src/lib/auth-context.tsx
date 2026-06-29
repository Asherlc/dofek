import { createContext, useContext, useEffect, useState } from "react";
import type { AuthUser } from "./auth.ts";
import { logout as doLogout, fetchCurrentUser } from "./auth.ts";
import { captureException } from "./telemetry.ts";

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  bootstrapError: string | null;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  bootstrapError: null,
  logout: doLogout,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser()
      .then((currentUser) => {
        setBootstrapError(null);
        setUser(currentUser);
      })
      .catch((error: unknown) => {
        captureException(error, { source: "auth-bootstrap" });
        setBootstrapError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, bootstrapError, logout: doLogout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
