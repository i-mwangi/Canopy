import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    env: {
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
        NEXT_PUBLIC_EXPLORER: process.env.NEXT_PUBLIC_EXPLORER ?? '',
    },
};

export default nextConfig;
