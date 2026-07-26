import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.APP_BASE_URL?.trim() || "http://localhost:3000",
  ),
  applicationName: "API Migration Autopilot",
  title: {
    default: "API Migration Autopilot",
    template: "%s · API Migration Autopilot",
  },
  description:
    "Evidence-backed API migration campaigns, repository assessment, validated patches, and customer-approved draft pull requests.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  robots: {
    index: false,
    follow: false,
  },
  openGraph: {
    type: "website",
    title: "API Migration Autopilot",
    description:
      "Evidence-backed API migration campaigns, private repository assessment, validated patches, and customer-approved draft pull requests.",
    images: [
      {
        url: "/og.png",
        width: 1_733,
        height: 909,
        alt: "A secure API migration pipeline from repository scan through validation and reviewed patch.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "API Migration Autopilot",
    description:
      "Evidence-backed API migrations with read-only assessment and exact-hash customer approval.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f5f6f8",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
