// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "ios/*", "android/*"],
  },
  {
    // A web rule: React Native <Text> renders apostrophes as-is, there are no HTML entities to escape.
    rules: { "react/no-unescaped-entities": "off" },
  },
]);
