export const THECRAG_PUBLIC_PROFILE_SCOPE = "thecrag:public-profile";

export function isTheCragPublicProfileScope(scopes: string | null | undefined): boolean {
  return scopes === THECRAG_PUBLIC_PROFILE_SCOPE;
}
