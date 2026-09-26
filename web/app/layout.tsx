import type { ReactNode } from "react";
// M0-W0: the one import this ticket is allowed to add here (per M0-W0's
// ticket instructions) — without it, `next build` never compiles
// globals.css/styles/tokens.css, so a broken @import or syntax error in
// the design system would surface only when M0-W2 rebuilds this file.
// Everything else about layout.tsx (the real app shell, nav, etc.) stays
// M0-D1/M0-W2's — do not add anything else here.
import "./globals.css";

// M0-D1: deliberately bare otherwise. M0-W2 owns the real app shell (top
// bar, navigation) and will replace this file.
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
