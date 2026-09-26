import type { ReactNode } from "react";

// M0-D1: deliberately bare. M0-W2 owns the real app shell (top bar,
// navigation) and will replace this file — do not add globals.css or any
// component import here; web/styles/ and web/components/ui/ don't exist yet.
export const metadata = {
  title: "Base Power Zeus",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
