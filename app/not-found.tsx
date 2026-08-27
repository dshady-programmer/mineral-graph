import Link from 'next/link';

/** 404. A wrong URL should land somewhere useful rather than on a dead end. */
export default function NotFound() {
  return (
    <main className="flex flex-col items-center justify-center gap-[.6rem] px-6 py-20 text-center">
      <span className="mb-[.35rem] rounded-[3px] bg-sunk px-[.55rem] py-1 font-mono text-[.66rem] uppercase tracking-[.1em] text-muted">
        Not found
      </span>
      <h2 className="text-[1.15rem] font-semibold">No such page</h2>
      <p className="m-0 max-w-[26rem] text-[.92rem] text-muted">
        That address doesn&rsquo;t match anything in the explorer. Product URLs look like{' '}
        <code className="rounded-[3px] bg-sunk px-[.35rem] py-[.1rem] font-mono text-[.85em]">
          /products/prod:ev-battery-nmc
        </code>
        .
      </p>
      <Link
        href="/"
        className="mt-2 rounded border border-line bg-surface px-[.9rem] py-[.45rem] font-mono text-[.74rem] text-ink transition-colors hover:border-teal hover:text-teal"
      >
        Back to products
      </Link>
    </main>
  );
}
