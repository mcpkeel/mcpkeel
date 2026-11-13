import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SITE } from "@/lib/site";
import "./globals.css";

// Self-hosted, so a visit sends nothing to a font service. Archivo is a
// variable font with a width axis; the headings use its narrow end.
const archivo = localFont({
  src: "./fonts/archivo-latin-wdth-normal.woff2",
  weight: "100 900",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
  variable: "--font-archivo",
  display: "swap",
});

// The italic is a separate family that is not preloaded: it sets a few
// words, and a preload would compete with the upright face on slow links.
const archivoItalic = localFont({
  src: "./fonts/archivo-latin-wdth-italic.woff2",
  style: "italic",
  weight: "100 900",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
  variable: "--font-archivo-italic",
  display: "swap",
  preload: false,
});

const commitMono = localFont({
  src: [
    { path: "./fonts/commit-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/commit-mono-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-commit-mono",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: "mcpkeel: the lockfile for MCP", template: "%s | mcpkeel" },
  description: SITE.description,
  applicationName: "mcpkeel",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "mcpkeel",
    title: "mcpkeel: the lockfile for MCP",
    description: "Pin what your MCP servers tell your agent, and fail the build when it changes.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "mcpkeel: the lockfile for MCP" }],
  },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#10202C",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${archivoItalic.variable} ${commitMono.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
