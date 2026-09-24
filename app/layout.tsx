import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Ohana Comisiones",
    template: "%s | Ohana Comisiones",
  },
  description:
    "Ohana Comisiones — sistema de gestión: clientes, repartos, remitos, gastos y facturación.",
  icons: {
    icon: [{ url: "/ohana.jpeg", sizes: "any", type: "image/jpeg" }],
    apple: [{ url: "/ohana.jpeg", sizes: "any", type: "image/jpeg" }],
  },
};

// NOTA: `force-dynamic` NO se define acá. El layout `(app)/layout.tsx` ya fuerza
// renderizado dinámico al usar `cookies()` (vía exigirAdmin). Eliminarlo de la raíz
// permite que el shell HTML (fuentes, CSS) se sirva desde caché y mejora el TTFB.

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-zinc-100 text-zinc-900">{children}</body>
    </html>
  );
}
