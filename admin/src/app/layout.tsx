import type { Metadata, Viewport } from "next"
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google"
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
  title: { default: "LinkPay Staff", template: "%s · LinkPay Staff" },
  description: "The LinkPay Business staff console.",
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#27394d" },
    { media: "(prefers-color-scheme: dark)", color: "#1c2a3b" },
  ],
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-NG" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${bricolage.variable} antialiased`}>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
