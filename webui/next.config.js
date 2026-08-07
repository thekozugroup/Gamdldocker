/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',

  // This is an admin panel for a service on someone's home network. The
  // defaults matter more than usual because it is often reachable without
  // authentication.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Nothing here should ever be framed — clickjacking a "delete
          // playlist" button is the obvious attack.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            // Next needs inline styles and, in dev, eval. No external origins
            // are contacted at runtime, so everything else is locked to self.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'" +
                (process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"),
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
          },
        ],
      },
    ]
  },
}

module.exports = nextConfig