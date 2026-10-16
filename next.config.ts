import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  typescript: {
    // TODO: remove once type errors are fixed
    ignoreBuildErrors: true,
  },

  // @resvg/resvg-js is a native Node addon (.node binary). Turbopack can't
  // bundle those, so keep it external: Node loads it at runtime and Vercel
  // ships the right platform binary with the function.
  serverExternalPackages: ["@resvg/resvg-js"],

  // The ticket renderer reads its fonts from disk at runtime, which Next's
  // file tracing can't see on its own. Without this the fonts are missing on
  // Vercel and the ticket silently falls back to the text-only confirmation.
  outputFileTracingIncludes: {
    "/api/**": ["./lib/whatsapp/fonts/**/*"],
    "/kiosk/**": ["./lib/whatsapp/fonts/**/*"],
  },
}

export default nextConfig
