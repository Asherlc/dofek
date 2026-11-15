const baseConfig = require("./stryker.ci.config.json");

module.exports = {
  ...baseConfig,
  vitest: {
    ...baseConfig.vitest,
    configFile: "vitest.config.shared-mutation.ts",
  },
};
