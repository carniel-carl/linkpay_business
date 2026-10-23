import type { Metadata, Viewport } from "next"
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google"
import { headers } from "next/headers"
import { Providers } from "@/components/common/providers"
import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
})

export const metadata: Metadata = {
  title: { default: "LinkPay Business", template: "%s · LinkPay Business" },
  description: "Business banking for Nigerian businesses.",
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#27394d" },
    { media: "(prefers-color-scheme: dark)", color: "#1c2a3b" },
  ],
}

// The proxy's per-request nonce (src/proxy.ts), for next-themes' inline script. Reading it renders every page per
// request, which a nonce needs: a page built ahead of time would carry no nonce, or a stale one.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const nonce = (await headers()).get("x-nonce") ?? undefined
  return (
    <html lang="en-NG" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${bricolage.variable} antialiased`}>
      <body className="min-h-dvh">
        <Providers nonce={nonce}>{children}</Providers>
      </body>
    </html>
  )
}
