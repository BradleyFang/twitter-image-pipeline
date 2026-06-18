import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "pbs.twimg.com",
        pathname: "/media/**",
      },
      {
        protocol: "https",
        hostname: "pbs.twimg.com",
        pathname: "/tweet_video_thumb/**",
      },
      {
        protocol: "https",
        hostname: "pbs.twimg.com",
        pathname: "/amplify_video_thumb/**",
      },
      {
        protocol: "https",
        hostname: "pbs.twimg.com",
        pathname: "/ext_tw_video_thumb/**",
      },
    ],
  },
};

export default nextConfig;
