export interface AuthProviderGroups {
  identityProviders: string[];
  dataProviders: string[];
  showIdentityProviders: boolean;
  showDataProviders: boolean;
  showOAuthProviders: boolean;
}

export function groupConfiguredAuthProviders(
  providers: { identity: readonly string[]; data: readonly string[] },
  excludedIdentityProviders?: readonly string[],
): AuthProviderGroups {
  const excluded = new Set(excludedIdentityProviders);
  const identityProviders = providers.identity.filter((id) => !excluded.has(id));
  const dataProviders = [...providers.data];
  const showIdentityProviders = identityProviders.length > 0;
  const showDataProviders = dataProviders.length > 0;

  return {
    identityProviders,
    dataProviders,
    showIdentityProviders,
    showDataProviders,
    showOAuthProviders: showIdentityProviders || showDataProviders,
  };
}
