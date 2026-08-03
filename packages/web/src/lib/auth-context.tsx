import { ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE } from "@dofek/auth/account-erasure";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { clearAccountErasurePreparation } from "./account-erasure-storage.ts";
import type { AuthUser } from "./auth.ts";
import { logout as doLogout, fetchCurrentUser, redirectToLogin } from "./auth.ts";
import { identifyPostHogUser, resetPostHogUser } from "./posthog.ts";
import { captureException, identifyUser, resetUser } from "./telemetry.ts";
import {
  acquireWebAccountStateLock,
  type WebAccountStateLockLease,
  webAccountStateLocksAreAvailable,
} from "./web-account-state-lock.ts";

export interface AccountErasureCleanupLease {
  cleanupId: number;
  cleanupOwnerNonce: string;
  sessionGeneration: number;
}

interface AuthContextValue {
  accountErasureCleanupInProgress: boolean;
  accountSessionOwnerNonce: string | null;
  user: AuthUser | null;
  isLoading: boolean;
  bootstrapError: string | null;
  beginAccountErasureCleanup: (ownerUserId: string) => Promise<AccountErasureCleanupLease>;
  beginAccountErasureCleanupForNonce: (
    cleanupOwnerNonce: string,
  ) => Promise<AccountErasureCleanupLease>;
  finishAccountErasureCleanup: (lease: AccountErasureCleanupLease) => void;
  isAccountErasureCleanupLeaseCurrent: (lease: AccountErasureCleanupLease) => boolean;
  logout: () => Promise<void>;
  retryBootstrap: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  accountErasureCleanupInProgress: false,
  accountSessionOwnerNonce: null,
  user: null,
  isLoading: true,
  bootstrapError: null,
  beginAccountErasureCleanup: async () => {
    throw new Error("AuthProvider is unavailable.");
  },
  beginAccountErasureCleanupForNonce: async () => {
    throw new Error("AuthProvider is unavailable.");
  },
  finishAccountErasureCleanup: () => undefined,
  isAccountErasureCleanupLeaseCurrent: () => false,
  logout: doLogout,
  retryBootstrap: async () => undefined,
});

const WEB_SESSION_OWNER_NONCE_KEY = "dofek:session-owner-nonce:v1";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [accountErasureCleanupInProgress, setAccountErasureCleanupInProgress] = useState(false);
  const [accountSessionOwnerNonce, setAccountSessionOwnerNonce] = useState<string | null>(null);
  const activeCleanupLeaseRef = useRef<AccountErasureCleanupLease | null>(null);
  const activeCleanupLockRef = useRef<WebAccountStateLockLease | null>(null);
  const cleanupLockAcquisitionPendingRef = useRef(false);
  const nextCleanupIdRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const sessionOwnerNonceRef = useRef<string | null>(null);
  const userRef = useRef<AuthUser | null>(null);
  const identifiedUserId = useRef<string | null>(null);

  const updateUser = useCallback((nextUser: AuthUser | null) => {
    userRef.current = nextUser;
    setUser(nextUser);
  }, []);

  const updateSessionOwnerNonce = useCallback((nonce: string | null) => {
    sessionOwnerNonceRef.current = nonce;
    setAccountSessionOwnerNonce(nonce);
  }, []);

  const synchronizeAuthoritativeSession = useCallback(
    (currentUser: AuthUser | null, rotateNonce: boolean): string | null => {
      if (!currentUser) {
        window.localStorage.removeItem(WEB_SESSION_OWNER_NONCE_KEY);
        updateSessionOwnerNonce(null);
        updateUser(null);
        return null;
      }

      const persistedNonce = window.localStorage.getItem(WEB_SESSION_OWNER_NONCE_KEY);
      const sessionOwnerNonce =
        rotateNonce || !persistedNonce ? crypto.randomUUID() : persistedNonce;
      window.localStorage.setItem(WEB_SESSION_OWNER_NONCE_KEY, sessionOwnerNonce);
      updateSessionOwnerNonce(sessionOwnerNonce);
      updateUser(currentUser);
      return sessionOwnerNonce;
    },
    [updateSessionOwnerNonce, updateUser],
  );

  const retryBootstrap = useCallback(async () => {
    if (activeCleanupLeaseRef.current || cleanupLockAcquisitionPendingRef.current) return;
    setIsLoading(true);
    let stateLock: WebAccountStateLockLease | null = null;
    try {
      if (webAccountStateLocksAreAvailable()) {
        stateLock = await acquireWebAccountStateLock();
      }
      if (activeCleanupLeaseRef.current) return;
      const bootstrapGeneration = sessionGenerationRef.current;
      const currentUser = await fetchCurrentUser();
      if (activeCleanupLeaseRef.current || sessionGenerationRef.current !== bootstrapGeneration) {
        return;
      }
      const previousUserId = userRef.current?.id;
      const userChanged = currentUser?.id !== previousUserId;
      if (userChanged) {
        sessionGenerationRef.current += 1;
      }
      const accountTransition =
        currentUser !== null && previousUserId !== undefined && currentUser.id !== previousUserId;
      synchronizeAuthoritativeSession(currentUser, accountTransition);
      setBootstrapError(null);
      if (currentUser) {
        if (identifiedUserId.current && identifiedUserId.current !== currentUser.id) {
          resetUser();
        }
        identifyUser(currentUser);
        identifiedUserId.current = currentUser.id;
      } else if (identifiedUserId.current) {
        resetUser();
        identifiedUserId.current = null;
      }
    } catch (error: unknown) {
      captureException(error, { source: "auth-bootstrap" });
      setBootstrapError(error instanceof Error ? error.message : String(error));
    } finally {
      stateLock?.release();
      setIsLoading(false);
    }
  }, [synchronizeAuthoritativeSession]);

  useEffect(() => {
    void retryBootstrap();
  }, [retryBootstrap]);

  useEffect(() => {
    if (isLoading) return;
    if (user) {
      identifyPostHogUser(user.id);
    } else {
      resetPostHogUser();
    }
  }, [isLoading, user]);

  useEffect(() => {
    const updateNonceFromAnotherTab = (event: StorageEvent) => {
      if (event.key !== WEB_SESSION_OWNER_NONCE_KEY) return;
      if (
        event.newValue === null &&
        activeCleanupLeaseRef.current?.cleanupOwnerNonce === event.oldValue
      ) {
        return;
      }
      sessionGenerationRef.current += 1;
      updateSessionOwnerNonce(event.newValue);
    };
    window.addEventListener("storage", updateNonceFromAnotherTab);
    return () => window.removeEventListener("storage", updateNonceFromAnotherTab);
  }, [updateSessionOwnerNonce]);

  const startAccountErasureCleanup = useCallback(
    (
      cleanupOwnerNonce: string,
      clearCurrentAuth: boolean,
      stateLock: WebAccountStateLockLease,
    ): AccountErasureCleanupLease => {
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
      activeCleanupLeaseRef.current = cleanupLease;
      activeCleanupLockRef.current = stateLock;
      setAccountErasureCleanupInProgress(true);
      if (clearCurrentAuth) {
        updateUser(null);
      }
      setBootstrapError(null);
      return cleanupLease;
    },
    [updateUser],
  );

  const beginAccountErasureCleanup = useCallback(
    async (ownerUserId: string): Promise<AccountErasureCleanupLease> => {
      if (activeCleanupLeaseRef.current || cleanupLockAcquisitionPendingRef.current) {
        throw new Error("Local account deletion cleanup is already in progress.");
      }
      cleanupLockAcquisitionPendingRef.current = true;
      let stateLock: WebAccountStateLockLease | null = null;
      try {
        stateLock = await acquireWebAccountStateLock();
        const currentUser = await fetchCurrentUser();
        const currentSessionBelongsToOwner = currentUser?.id === ownerUserId;
        const userChanged = currentUser?.id !== userRef.current?.id;
        const cleanupOwnerNonce = synchronizeAuthoritativeSession(
          currentUser,
          currentUser !== null && userChanged,
        );
        if (!currentSessionBelongsToOwner || !cleanupOwnerNonce) {
          throw new Error(ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE);
        }
        return startAccountErasureCleanup(cleanupOwnerNonce, true, stateLock);
      } catch (error: unknown) {
        stateLock?.release();
        throw error;
      } finally {
        cleanupLockAcquisitionPendingRef.current = false;
      }
    },
    [startAccountErasureCleanup, synchronizeAuthoritativeSession],
  );

  const beginAccountErasureCleanupForNonce = useCallback(
    async (cleanupOwnerNonce: string): Promise<AccountErasureCleanupLease> => {
      if (activeCleanupLeaseRef.current || cleanupLockAcquisitionPendingRef.current) {
        throw new Error("Local account deletion cleanup is already in progress.");
      }
      cleanupLockAcquisitionPendingRef.current = true;
      let stateLock: WebAccountStateLockLease | null = null;
      try {
        stateLock = await acquireWebAccountStateLock();
        const persistedNonce = window.localStorage.getItem(WEB_SESSION_OWNER_NONCE_KEY);
        const currentUser = await fetchCurrentUser();
        const userChanged = currentUser?.id !== userRef.current?.id;
        if (currentUser && userChanged) {
          synchronizeAuthoritativeSession(currentUser, true);
          throw new Error(ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE);
        }
        if (persistedNonce !== null && persistedNonce !== cleanupOwnerNonce) {
          synchronizeAuthoritativeSession(currentUser, false);
          throw new Error(ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE);
        }
        if (currentUser) {
          synchronizeAuthoritativeSession(currentUser, false);
        } else {
          updateUser(null);
          updateSessionOwnerNonce(persistedNonce);
        }
        return startAccountErasureCleanup(
          cleanupOwnerNonce,
          persistedNonce === cleanupOwnerNonce,
          stateLock,
        );
      } catch (error: unknown) {
        stateLock?.release();
        throw error;
      } finally {
        cleanupLockAcquisitionPendingRef.current = false;
      }
    },
    [
      startAccountErasureCleanup,
      synchronizeAuthoritativeSession,
      updateSessionOwnerNonce,
      updateUser,
    ],
  );

  const finishAccountErasureCleanup = useCallback((lease: AccountErasureCleanupLease) => {
    if (activeCleanupLeaseRef.current !== lease) return;
    activeCleanupLeaseRef.current = null;
    activeCleanupLockRef.current?.release();
    activeCleanupLockRef.current = null;
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
      return (
        sessionOwnerNonceRef.current === lease.cleanupOwnerNonce ||
        (userRef.current === null && sessionOwnerNonceRef.current === null)
      );
    },
    [],
  );

  const logout = useCallback(async () => {
    sessionGenerationRef.current += 1;
    window.localStorage.removeItem(WEB_SESSION_OWNER_NONCE_KEY);
    updateSessionOwnerNonce(null);
    updateUser(null);
    setBootstrapError(null);
    clearAccountErasurePreparation();
    try {
      await doLogout();
    } catch (error: unknown) {
      captureException(error, { source: "logout" });
      throw error;
    }
    resetUser();
    identifiedUserId.current = null;
    redirectToLogin();
  }, [updateSessionOwnerNonce, updateUser]);

  return (
    <AuthContext.Provider
      value={{
        accountErasureCleanupInProgress,
        accountSessionOwnerNonce,
        user,
        isLoading,
        bootstrapError,
        beginAccountErasureCleanup,
        beginAccountErasureCleanupForNonce,
        finishAccountErasureCleanup,
        isAccountErasureCleanupLeaseCurrent,
        logout,
        retryBootstrap,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
