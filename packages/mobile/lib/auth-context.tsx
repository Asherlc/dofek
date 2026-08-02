import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { clearMobileAccountErasurePreparation } from "./account-erasure-storage";
import {
  type AuthUser,
  logout as authLogout,
  clearSessionToken,
  createAccountErasureCleanupNonce,
  fetchCurrentUser,
  getOrCreateSessionOwnerNonce,
  getSessionToken,
  invalidateSessionPersistence,
  rotateSessionOwnerNonce,
  saveSessionToken,
} from "./auth";
import { removeMobileQueryCache } from "./mobile-query-persistence";
import { isSecureStoreAccessibilityError } from "./secure-store-access";
import { SERVER_URL } from "./server";
import { captureException } from "./telemetry";

export interface AccountErasureCleanupLease {
  cleanupId: number;
  cleanupOwnerNonce: string;
  sessionGeneration: number;
}

interface AuthState {
  /** True while accepted account erasure is clearing account-owned device state. */
  accountErasureCleanupInProgress: boolean;
  /** Opaque local owner marker rotated whenever a server session is adopted. */
  accountSessionOwnerNonce: string | null;
  /** The authenticated user, or null if not logged in. */
  user: AuthUser | null;
  /** The server URL (always the production server). */
  serverUrl: string;
  /** True while loading auth state from secure storage. */
  isLoading: boolean;
  /** Real auth bootstrap failure, distinct from no saved session. */
  bootstrapError: string | null;
  /** Start an app-wide cleanup gate after the server accepts account erasure. */
  beginAccountErasureCleanup: (ownerUserId: string) => AccountErasureCleanupLease;
  /** Start cleanup from a persisted opaque owner marker without retaining a user ID. */
  beginAccountErasureCleanupForNonce: (cleanupOwnerNonce: string) => AccountErasureCleanupLease;
  /** Release the app-wide cleanup gate held by this lease. */
  finishAccountErasureCleanup: (lease: AccountErasureCleanupLease) => void;
  /** Verify that destructive cleanup still belongs to the same local session generation. */
  isAccountErasureCleanupLeaseCurrent: (lease: AccountErasureCleanupLease) => boolean;
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
  const [accountErasureCleanupInProgress, setAccountErasureCleanupInProgress] = useState(false);
  const [accountSessionOwnerNonce, setAccountSessionOwnerNonce] = useState<string | null>(null);
  const activeCleanupLeaseRef = useRef<AccountErasureCleanupLease | null>(null);
  const bootstrapDeferredRef = useRef(false);
  const nextCleanupIdRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const sessionOwnerNonceRef = useRef<string | null>(null);
  const sessionTokenRef = useRef<string | null>(null);
  const userRef = useRef<AuthUser | null>(null);

  const updateSessionToken = useCallback((token: string | null) => {
    sessionTokenRef.current = token;
    setSessionToken(token);
  }, []);

  const updateUser = useCallback((nextUser: AuthUser | null) => {
    userRef.current = nextUser;
    setUser(nextUser);
  }, []);

  const updateSessionOwnerNonce = useCallback((nonce: string | null) => {
    sessionOwnerNonceRef.current = nonce;
    setAccountSessionOwnerNonce(nonce);
  }, []);

  const retryBootstrap = useCallback(async () => {
    if (activeCleanupLeaseRef.current) return;
    setIsLoading(true);
    bootstrapDeferredRef.current = false;
    let deferBootstrap = false;
    const bootstrapGeneration = sessionGenerationRef.current;
    try {
      const token = await getSessionToken();
      if (activeCleanupLeaseRef.current || sessionGenerationRef.current !== bootstrapGeneration) {
        return;
      }
      if (!token) {
        if (AppState.currentState === "background") {
          // iOS can relaunch the app in the background while the device is locked.
          // SecureStore reads fail with errSecInteractionNotAllowed in that state,
          // so defer auth restore until the user brings the app to the foreground.
          deferBootstrap = true;
          bootstrapDeferredRef.current = true;
          updateUser(null);
          updateSessionToken(null);
          updateSessionOwnerNonce(null);
          setBootstrapError(null);
          return;
        }

        updateUser(null);
        updateSessionToken(null);
        updateSessionOwnerNonce(null);
        setBootstrapError(null);
        return;
      }

      // Re-save to migrate existing tokens to AFTER_FIRST_UNLOCK accessibility
      // so they remain readable when the app runs in the background while locked.
      const restoreGeneration = bootstrapGeneration + 1;
      sessionGenerationRef.current = restoreGeneration;
      await saveSessionToken(token);
      if (activeCleanupLeaseRef.current || sessionGenerationRef.current !== restoreGeneration)
        return;
      updateSessionToken(token);

      const currentUser = await fetchCurrentUser(SERVER_URL, token);
      if (activeCleanupLeaseRef.current || sessionGenerationRef.current !== restoreGeneration)
        return;
      if (currentUser) {
        const sessionOwnerNonce = await getOrCreateSessionOwnerNonce();
        if (activeCleanupLeaseRef.current || sessionGenerationRef.current !== restoreGeneration) {
          return;
        }
        updateSessionOwnerNonce(sessionOwnerNonce);
        updateUser(currentUser);
        setBootstrapError(null);
      } else {
        await clearSessionToken();
        updateUser(null);
        updateSessionToken(null);
        updateSessionOwnerNonce(null);
        setBootstrapError(null);
      }
    } catch (error: unknown) {
      if (isSecureStoreAccessibilityError(error) && AppState.currentState === "background") {
        // iOS can relaunch the app in the background while the device is locked.
        // SecureStore reads fail with errSecInteractionNotAllowed in that state,
        // so defer auth restore until the user brings the app to the foreground.
        deferBootstrap = true;
        bootstrapDeferredRef.current = true;
        updateUser(null);
        updateSessionToken(null);
        updateSessionOwnerNonce(null);
        setBootstrapError(null);
        return;
      }

      captureException(error, { source: "auth-state-restore" });
      updateUser(null);
      setBootstrapError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!deferBootstrap) {
        setIsLoading(false);
      }
    }
  }, [updateSessionOwnerNonce, updateSessionToken, updateUser]);

  // On mount, restore auth state from secure storage.
  useEffect(() => {
    void retryBootstrap();
  }, [retryBootstrap]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && bootstrapDeferredRef.current) {
        void retryBootstrap();
      }
    });

    return () => subscription.remove();
  }, [retryBootstrap]);

  const onLoginSuccess = useCallback(
    async (token: string) => {
      if (activeCleanupLeaseRef.current) {
        throw new Error(
          "Account deletion cleanup is still in progress. Try signing in again after cleanup finishes.",
        );
      }
      const loginGeneration = sessionGenerationRef.current + 1;
      sessionGenerationRef.current = loginGeneration;
      await saveSessionToken(token);
      if (activeCleanupLeaseRef.current || sessionGenerationRef.current !== loginGeneration) {
        throw new Error(
          "Account deletion cleanup is still in progress. Try signing in again after cleanup finishes.",
        );
      }
      updateSessionToken(token);

      const currentUser = await fetchCurrentUser(SERVER_URL, token);
      if (activeCleanupLeaseRef.current || sessionGenerationRef.current !== loginGeneration) {
        throw new Error(
          "Account deletion cleanup is still in progress. Try signing in again after cleanup finishes.",
        );
      }
      const sessionOwnerNonce = await rotateSessionOwnerNonce();
      if (activeCleanupLeaseRef.current || sessionGenerationRef.current !== loginGeneration) {
        throw new Error(
          "Account deletion cleanup is still in progress. Try signing in again after cleanup finishes.",
        );
      }
      updateSessionOwnerNonce(sessionOwnerNonce);
      updateUser(currentUser);
      setBootstrapError(null);
    },
    [updateSessionOwnerNonce, updateSessionToken, updateUser],
  );

  const startAccountErasureCleanup = useCallback(
    (cleanupOwnerNonce: string, clearCurrentAuth: boolean): AccountErasureCleanupLease => {
      if (activeCleanupLeaseRef.current) {
        throw new Error("Local account deletion cleanup is already in progress.");
      }
      const sessionGeneration = sessionGenerationRef.current + 1;
      sessionGenerationRef.current = sessionGeneration;
      const cleanupLease = {
        cleanupId: nextCleanupIdRef.current + 1,
        cleanupOwnerNonce,
        sessionGeneration,
      };
      nextCleanupIdRef.current = cleanupLease.cleanupId;
      if (clearCurrentAuth || (userRef.current === null && sessionTokenRef.current === null)) {
        invalidateSessionPersistence();
      }
      activeCleanupLeaseRef.current = cleanupLease;
      setAccountErasureCleanupInProgress(true);

      if (clearCurrentAuth) {
        updateSessionToken(null);
        updateUser(null);
      }
      setBootstrapError(null);
      return cleanupLease;
    },
    [updateSessionToken, updateUser],
  );

  const beginAccountErasureCleanup = useCallback(
    (ownerUserId: string): AccountErasureCleanupLease => {
      const currentUser = userRef.current;
      const currentSessionBelongsToOwner = currentUser?.id === ownerUserId;
      const cleanupOwnerNonce =
        currentUser === null || currentSessionBelongsToOwner
          ? (sessionOwnerNonceRef.current ?? createAccountErasureCleanupNonce())
          : createAccountErasureCleanupNonce();
      return startAccountErasureCleanup(cleanupOwnerNonce, currentSessionBelongsToOwner);
    },
    [startAccountErasureCleanup],
  );

  const beginAccountErasureCleanupForNonce = useCallback(
    (cleanupOwnerNonce: string): AccountErasureCleanupLease =>
      startAccountErasureCleanup(
        cleanupOwnerNonce,
        sessionOwnerNonceRef.current === cleanupOwnerNonce,
      ),
    [startAccountErasureCleanup],
  );

  const finishAccountErasureCleanup = useCallback((lease: AccountErasureCleanupLease) => {
    if (activeCleanupLeaseRef.current !== lease) return;
    activeCleanupLeaseRef.current = null;
    setAccountErasureCleanupInProgress(false);
  }, []);

  const isAccountErasureCleanupLeaseCurrent = useCallback(
    (lease: AccountErasureCleanupLease): boolean => {
      if (
        activeCleanupLeaseRef.current !== lease ||
        sessionGenerationRef.current !== lease.sessionGeneration
      ) {
        return false;
      }
      const currentUser = userRef.current;
      return (
        sessionOwnerNonceRef.current === lease.cleanupOwnerNonce ||
        (currentUser === null &&
          sessionTokenRef.current === null &&
          sessionOwnerNonceRef.current === null)
      );
    },
    [],
  );

  const clearLocalAuthState = useCallback(() => {
    sessionGenerationRef.current += 1;
    updateSessionToken(null);
    updateSessionOwnerNonce(null);
    updateUser(null);
    setBootstrapError(null);
  }, [updateSessionOwnerNonce, updateSessionToken, updateUser]);

  const logout = useCallback(async () => {
    const currentUserId = user?.id;
    const token = sessionToken;
    const logoutOperation = token ? authLogout(SERVER_URL, token) : clearSessionToken();
    // Clear React state immediately so the UI shows the login screen
    clearLocalAuthState();
    await clearMobileAccountErasurePreparation();

    if (currentUserId) {
      await removeMobileQueryCache(currentUserId);
    }

    try {
      await logoutOperation;
    } catch (error: unknown) {
      captureException(error, { source: "logout" });
    }
  }, [clearLocalAuthState, sessionToken, user?.id]);

  const value = useMemo(
    () => ({
      user,
      serverUrl: SERVER_URL,
      isLoading,
      bootstrapError,
      accountErasureCleanupInProgress,
      accountSessionOwnerNonce,
      beginAccountErasureCleanup,
      beginAccountErasureCleanupForNonce,
      finishAccountErasureCleanup,
      isAccountErasureCleanupLeaseCurrent,
      sessionToken,
      onLoginSuccess,
      logout,
      retryBootstrap,
    }),
    [
      user,
      isLoading,
      bootstrapError,
      accountErasureCleanupInProgress,
      accountSessionOwnerNonce,
      sessionToken,
      onLoginSuccess,
      beginAccountErasureCleanup,
      beginAccountErasureCleanupForNonce,
      finishAccountErasureCleanup,
      isAccountErasureCleanupLeaseCurrent,
      logout,
      retryBootstrap,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
