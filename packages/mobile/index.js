if (process.env.EXPO_PUBLIC_STORYBOOK_ENABLED === "true") {
  module.exports = require("./.rnstorybook");
} else {
  module.exports = require("expo-router/entry");
}
