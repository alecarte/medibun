const path = require("path");

/**
 * jest-expo is the React Native / Expo test runner (Vitest can't replace it for RN).
 *
 * transformIgnorePatterns: in this pnpm monorepo, react-native and friends are hoisted
 * under the root `node_modules/.pnpm/<pkg>@<ver>/node_modules/...`. The negative-lookahead
 * is anchored to allow an optional `.pnpm/...` segment before the package name so Babel
 * still transforms those ESM packages.
 *
 * moduleNameMapper: jest's resolver doesn't follow the pnpm workspace symlinks for our
 * `@medibun/*` packages, so map them to their built entrypoints explicitly.
 */
module.exports = {
  preset: "jest-expo",
  transformIgnorePatterns: [
    "node_modules/(?!(?:.pnpm/[^/]+/node_modules/)?(?:(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|react-native-reanimated|react-native-worklets|@shopify/restyle))",
  ],
  moduleNameMapper: {
    "^@medibun/design-tokens$": path.resolve(
      __dirname,
      "../../packages/design-tokens/dist/index.js",
    ),
    "^@medibun/api-client$": path.resolve(__dirname, "../../packages/api-client/dist/index.js"),
  },
  testMatch: ["**/*.test.tsx", "**/*.test.ts"],
};
