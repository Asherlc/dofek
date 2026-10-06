const nativeMessages = new Map([
  ["ERR_REQUEST_UNKNOWN", "Apple could not complete sign-in. Please try again."],
  ["ERR_REQUEST_FAILED", "Apple sign-in failed. Please try again."],
  ["ERR_INVALID_RESPONSE", "Apple returned an invalid sign-in response. Please try again."],
  ["ERR_REQUEST_NOT_HANDLED", "Apple could not handle the sign-in request. Please try again."],
  ["ERR_REQUEST_NOT_INTERACTIVE", "Open Dofek in the foreground and try Apple sign-in again."],
  [
    "ERR_REQUEST_MATCHED_EXCLUDED_CREDENTIAL",
    "Apple could not use this credential. Try another sign-in method.",
  ],
]);

// Expo's JS bridge preserves code and message, but not arbitrary native fields.
// The patched native cause emits only this grammar; reject anything else.
const domain =
  "(?:com\\.apple\\.AuthenticationServices\\.AuthorizationError|AKAuthenticationError|NSCocoaErrorDomain|NSPOSIXErrorDomain|NSURLErrorDomain|other)";
const diagnosticMarker = new RegExp(
  `\\[dofek\\.apple-auth domain=(${domain}) code=(-?\\d{1,16})(?: underlyingDomain=(${domain}) underlyingCode=(-?\\d{1,16}))?\\]`,
);

export function appleSignInDiagnostic(error: unknown):
  | {
      error: Error;
      context: Record<string, string | number>;
    }
  | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return undefined;
  }
  const message = nativeMessages.get(error.code);
  if (!message) return undefined;

  const context: Record<string, string | number> = { appleCode: error.code };
  const marker =
    "message" in error && typeof error.message === "string"
      ? diagnosticMarker.exec(error.message)
      : null;
  if (marker) {
    const [, nativeDomain, nativeCode, underlyingDomain, underlyingCode] = marker;
    const code = Number(nativeCode);
    const causeCode = underlyingCode === undefined ? undefined : Number(underlyingCode);
    if (
      nativeDomain &&
      Number.isSafeInteger(code) &&
      (causeCode === undefined || Number.isSafeInteger(causeCode))
    ) {
      context.nativeDomain = nativeDomain;
      context.nativeCode = code;
      if (underlyingDomain && causeCode !== undefined) {
        context.underlyingDomain = underlyingDomain;
        context.underlyingCode = causeCode;
      }
    }
  }
  return { error: new Error(message), context };
}
