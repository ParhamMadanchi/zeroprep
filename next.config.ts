import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // The local stack is reached as either localhost or 127.0.0.1 depending on how
  // it was opened. Without this, Next.js dev treats the other spelling as a
  // cross-origin request and blocks its own dev resources.
  allowedDevOrigins: ["127.0.0.1", "localhost", "::1"],
};

export default nextConfig;
