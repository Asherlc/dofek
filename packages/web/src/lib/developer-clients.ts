import { createDeveloperClientsApi } from "@dofek/auth/developer-clients";

export const developerClientsApi = createDeveloperClientsApi((path, init) =>
  fetch(path, { ...init, credentials: "include" }),
);
