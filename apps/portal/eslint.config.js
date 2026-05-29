import base from "../../eslint.config.js";

export default [
  ...base,
  {
    ignores: [".next/**", "next-env.d.ts"],
  },
];
