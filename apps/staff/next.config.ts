import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Transpile the workspace packages the app consumes.
  transpilePackages: ["@medibun/design-tokens", "@medibun/api-client"],
  // React Compiler (stable in React 19; top-level opt-in as of Next 16.2).
  reactCompiler: true,
  // Same-origin proxy pattern (docs/AUTH.md): the browser only ever talks to the app's
  // own origin; /api/* forwards to the BFF so the session cookie stays first-party.
  // Prod uses the equivalent Vercel rewrite.
  async rewrites() {
    const target = (process.env.API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
    return [{ source: "/api/:path*", destination: `${target}/:path*` }];
  },
};

export default nextConfig;
