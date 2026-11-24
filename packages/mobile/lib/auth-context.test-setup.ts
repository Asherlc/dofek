import { waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { expect } from "vitest";
import { AuthProvider } from "./auth-context";

/** Shared React wrapper and helpers — Vitest forbids exporting `vi.hoisted` from a module. */
export const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(AuthProvider, null, children);

export const defaultUser = { id: "user-1", name: "Test User", email: "test@example.com" };

export const waitForAuthLoaded = (result: { current: { isLoading: boolean } }) =>
  waitFor(() => expect(result.current.isLoading).toBe(false));

export const importAuthApis = async () =>
  Object.assign(await import("./auth"), await import("./auth-session"));
