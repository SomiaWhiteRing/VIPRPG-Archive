import type { Metadata } from "next";
import "./globals.css";
import { LanguageProvider } from "@/components/language-context";
import SiteChrome from "@/components/site-chrome";

export const metadata: Metadata = {
  title: "VIPRPG Archive Prototype",
  description: "Sample implementation for an all-in-one VIPRPG festival archive",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        <LanguageProvider>
          <SiteChrome>{children}</SiteChrome>
        </LanguageProvider>
      </body>
    </html>
  );
}
