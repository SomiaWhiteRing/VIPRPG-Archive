import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.VIPRPG_DIST_DIR || ".next",
  async headers() {
    return [{
      source: "/original-pages/:festival/fonts/:path*",
      headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
    }];
  },
};

export default nextConfig;
