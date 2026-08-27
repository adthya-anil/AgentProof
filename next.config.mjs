/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },

  webpack: (config) => {
    /*
     * The engine under src/lib uses ESM-style `.js` specifiers that point at
     * `.ts` sources — required for `tsx`/Node ESM to run the CLI demos directly.
     * Webpack does not apply that mapping on its own, so teach it to.
     *
     * The alternative (dropping extensions from every import) would break the
     * demo scripts, which are the primary interface for this project.
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
