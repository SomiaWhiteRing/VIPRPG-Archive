import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LanguageProvider } from "@/components/language-context";
import SiteChrome from "@/components/site-chrome";

export const metadata: Metadata = {
  title: "VIPRPG祭典保存库",
  description: "将祭典信息转储为静态资源并免费托管以长久保存与检索用的备份仓库",
  icons: { icon: "/icon/windI.png", shortcut: "/icon/windI.png" },
};

// Let mobile browsers fit the same desktop layout to the screen.
export const viewport: Viewport = {
  width: 1280,
  initialScale: undefined,
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
