'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProductSummary } from '@/app/api/products/route';
import { LoadingState, EmptyState, ErrorState } from '@/components/States';

/**
 * One state value with a status tag, rather than separate data/error/loading
 * flags. Two reasons: impossible combinations (data AND error) stop being
 * representable, and nothing sets state before the first await, which would
 * cause a cascading render.
 */
type View =
  | { status: 'loading' }
  | { status: 'ready'; products: ProductSummary[] }
  | { status: 'error'; message: string };

export default function Home() {
  const router = useRouter();
  const [view, setView] = useState<View>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // Guards against a slow first response landing after a newer one and
    // overwriting it - a real race once a retry button exists.
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/products');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok || body.status === 'error') {
          setView({
            status: 'error',
            message: body.message ?? 'The server returned an unexpected response.',
          });
          return;
        }
        setView({ status: 'ready', products: body.products });
      } catch {
        // Network-level failure - the request never reached the server, so
        // there is no server message to show.
        if (!cancelled) {
          setView({
            status: 'error',
            message: 'Could not reach the server. Check your connection and try again.',
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [reloadKey]);

  const retry = () => {
    setView({ status: 'loading' });
    setReloadKey((k) => k + 1);
  };

  return (
    <main>
      <section className="mb-11 max-w-[44rem]">
        <p className="mb-[.8rem] font-mono text-[.68rem] uppercase tracking-[.14em] text-teal">
          Critical minerals · provenance by traversal
        </p>
        <h1 className="mb-[.85rem] text-[clamp(1.9rem,4.4vw,2.7rem)] font-bold leading-[1.08]">
          Where the materials in a finished product actually came from.
        </h1>
        <p className="m-0 text-[1.03rem] text-muted">
          Minerals move from orebody through concentration, smelting and refining before
          they reach a factory. Choose a product to trace every route back to the mine
          that started it — and see which country refines what it never mined.
        </p>
      </section>

      {view.status === 'error' && <ErrorState message={view.message} onRetry={retry} />}

      {view.status === 'loading' && (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="overflow-hidden rounded-md border border-line bg-surface shadow-card">
              <LoadingState label="Loading products" rows={4} />
            </div>
          ))}
        </div>
      )}

      {view.status === 'ready' && view.products.length === 0 && (
        <EmptyState
          title="No products in the graph yet"
          detail="The database is reachable but empty. Run node scripts/seed.mjs and reload."
        />
      )}

      {view.status === 'ready' && view.products.length > 0 && (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
          {view.products.map((p) => (
            <button
              key={p.id}
              type="button"
              // No encodeURIComponent: ':' is legal in a URL path segment (RFC 3986
              // pchar), and encoding it turns the readable id into
              // prod%3Aev-battery-nmc. The ids were designed to double as clean
              // route params, so leave them readable.
              onClick={() => router.push(`/products/${p.id}`)}
              className="flex cursor-pointer flex-col gap-[.7rem] rounded-md border border-line bg-surface px-[1.4rem] pt-[1.35rem] pb-[1.2rem] text-left shadow-card transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-teal hover:shadow-lift"
            >
              <span className="font-mono text-[.66rem] uppercase tracking-[.1em] text-faint">
                {p.category}
              </span>
              <h2 className="text-[1.16rem] font-semibold leading-tight">{p.name}</h2>
              <p className="m-0 flex-1 text-[.92rem] text-muted">{p.description}</p>
              <span className="flex items-baseline justify-between gap-[.9rem] border-t border-linesoft pt-[.8rem] font-mono text-[.72rem] text-muted">
                {/* The country list is variable length; ellipsise rather than
                    let it wrap underneath the call to action. */}
                <span className="min-w-0 truncate">
                  {p.plantCount} plant{p.plantCount === 1 ? '' : 's'}
                  {p.madeIn.length > 0 && ` · ${p.madeIn.join(', ')}`}
                </span>
                <span className="flex-none font-medium text-teal">Trace →</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
