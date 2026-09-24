import type { NextConfig } from "next";

/**
 * Headers de seguridad balanceados para producción y desarrollo.
 * La política CSP permite scripts y estilos 'unsafe-inline' porque:
 *   - Next.js necesita hidratación de cliente (scripts en línea)
 *   - Tailwind CSS usa estilos en línea en modo JIT
 *   - Seguimos protegiendo contra otras amenazas (XSS, clickjacking, etc.)
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // CSP que permite la app de Next.js + Tailwind
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " + // 'unsafe-eval' para desarrollo de Next.js
      "style-src 'self' 'unsafe-inline'; " +
      "font-src 'self'; " +
      "img-src 'self' data: blob:; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none';",
  },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  async headers() {
    const headers = [...securityHeaders];
    if (process.env.NODE_ENV === "production") {
      headers.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      });
    }
    return [
      {
        source: "/(.*)",
        headers,
      },
    ];
  },
};

export default nextConfig;
