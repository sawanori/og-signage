import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "WeWorkOG デジタルサイネージ",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
