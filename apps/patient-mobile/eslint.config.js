import base from "../../eslint.config.js";

export default [
  ...base,
  {
    ignores: [".expo/**", "expo-env.d.ts", "babel.config.js", "metro.config.js", "jest.config.js"],
  },
];
