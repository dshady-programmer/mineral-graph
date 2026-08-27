import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mineral Supply Chain Network',
  description:
    'Trace critical minerals from orebody to finished product as graph traversals over CognoDB.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto max-w-[84rem] px-6 pb-20">
          <header className="mb-10 flex items-center justify-between gap-4 border-b border-line pt-6 pb-5">
            <Link href="/" className="flex items-baseline gap-3">
              <span className="font-display text-[1.02rem] font-bold tracking-[-.02em]">
                Mineral Supply Chain
              </span>
              <span className="font-mono text-[.68rem] uppercase tracking-[.12em] text-faint">
                Network Explorer
              </span>
            </Link>
            <nav className="flex items-center gap-5">
              <Link
                href="/risk"
                className="font-mono text-[.72rem] text-muted transition-colors hover:text-teal"
              >
                Disruption &amp; chokepoints
              </Link>
              <span className="hidden font-mono text-[.7rem] tracking-[.04em] text-faint sm:inline">
                CognoDB · openCypher over Bolt
              </span>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
