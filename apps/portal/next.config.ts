import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Transpile the workspace packages the app consumes.
  transpilePackages: ["@medibun/design-tokens", "@medibun/api-client"],
  // React Compiler (stable in React 19; top-level opt-in as of Next 16.2).
  reactCompiler: true,
};

export default nextConfig;
