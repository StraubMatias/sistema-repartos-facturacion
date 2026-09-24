import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  NOMBRE_COOKIE_SESION,
  verificarCookieSesion,
} from "./lib/sesion";

/**
 * Proxy global de autenticación (Next.js 16 renombró `middleware` → `proxy`).
 *
 * Antes de renderizar cada ruta valida la cookie de sesión firma

da (HMAC).
 * - Sin sesión válida → redirige a `/login`.
 * - `/login`, `/api/*` y los estáticos quedan excluidos del matcher.
 *
 * Este archivo NO toca la base de datos: solo valida la firma. El usuario real
 * se resuelve después en `lib/auth.ts` (proxy.ts se ejecuta en el borde/CDN).
 * 
 * SEGURIDAD ADICIONAL:
 * - Rate limiting implícito por el edge de Vercel
 * - Headers de seguridad en next.config.ts
 */
export function proxy(request: NextRequest) {
  const cookie = request.cookies.get(NOMBRE_COOKIE_SESION)?.value;
  const sesion = verificarCookieSesion(cookie);

  if (sesion) {
    return NextResponse.next();
  }

  const url = new URL(request.url);
  if (url.pathname === "/login") {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Excluye login, assets de Next, favicon y archivos estáticos.
  // api/health se maneja internamente: el proxy permite el paso pero
  // la ruta misma (/api/health) verifica autenticación.
  matcher: [
    "/((?!login|_next/static|_next/image|favicon\\.ico|ohana\\.jpeg).*)",
  ],
};