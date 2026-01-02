import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Ensure the bundled SQLite seed DB is included in the serverless function.
  // Without this, Vercel/Next output tracing may omit quizgo.db.
  outputFileTracingIncludes: {
    'app/api/database/route': ['quizgo.db'],
  },
};

export default nextConfig;
