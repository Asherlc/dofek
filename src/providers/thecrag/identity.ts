export const THECRAG_PUBLIC_PROFILE_SCOPE = "thecrag:public-profile";
export const THECRAG_LOGBOOK_SCOPE = "thecrag:logbook-read";

export function isTheCragPublicProfileScope(scopes: string | null | undefined): boolean {
  return scopes === THECRAG_PUBLIC_PROFILE_SCOPE;
}
