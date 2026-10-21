import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.VIPRPG_DIST_DIR || ".next",
  output: "export",
  ...(process.env.NODE_ENV === "development" ? {
    async headers() {
      return [{
        source: "/original-pages/:festival/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      }];
    },
  } : {}),
};

export default nextConfig;
