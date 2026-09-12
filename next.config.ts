import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  typescript: {
    // TODO: remove once type errors are fixed
    ignoreBuildErrors: true,
  },
}

export default nextConfig
