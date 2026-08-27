'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LoadingState, EmptyState, ErrorState } from '@/components/States';
import type { CountryOption, Chokepoint } from '@/app/api/risk/route';
import type { Impact, CountryOperation } from '@/app/api/risk/[countryId]/route';

type Global =
  | { status: 'loading' }
  | { status: 'ready'; countries: CountryOption[]; chokepoints: Chokepoint[] }
  | { status: 'error'; message: string };

type Detail =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; operations: CountryOperation[]; impacts: Impact[] }
  | { status: 'error'; message: string };

const PANEL = 'overflow-hidden rounded-md border border-line bg-surface shadow-card';
const PANEL_HEAD =
  'flex items-baseline justify-between gap-3 border-b border-line bg-raised px-[1.1rem] py-[.95rem]';
const PANEL_TITLE = 'font-mono text-[.78rem] font-semibold uppercase tracking-[.1em]';

const SEVERITY: Record<Impact['severity'], { label: string; cls: string }> = {
  severed: { label: 'Stops', cls: 'bg-dangerwash text-danger' },
  reduced: { label: 'Thinned', cls: 'bg-ochrewash text-ochre' },
  clear: { label: 'Unaffected', cls: 'bg-sunk text-muted' },
};

export default function RiskPage() {
  const [global, setGlobal] = useState<Global>({ status: 'loading' });
  const [detail, setDetail] = useState<Detail>({ status: 'idle' });
  const [country, setCountry] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/risk');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok || body.status === 'error') {
          setGlobal({ status: 'error', message: body.message ?? 'Unexpected response.' });
          return;
        }
        setGlobal({ status: 'ready', countries: body.countries, chokepoints: body.chokepoints });
      } catch {
        if (!cancelled) {
          setGlobal({
            status: 'error',
            message: 'Could not reach the server. Check your connection and try again.',
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    if (!country) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/risk/${country}`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok || body.status === 'error') {
          setDetail({ status: 'error', message: body.message ?? 'Unexpected response.' });
          return;
        }
        setDetail({ status: 'ready', operations: body.operations, impacts: body.impacts });
      } catch {
        if (!cancelled) {
          setDetail({ status: 'error', message: 'Could not reach the server.' });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [country]);

  const selectCountry = (id: string) => {
    setCountry(id);
    setDetail({ status: 'loading' });
  };

  const selectedName =
    global.status === 'ready' ? global.countries.find((c) => c.id === country)?.name : null;

  return (
    <main>
      <Link
        href="/"
        className="mb-[1.1rem] inline-flex items-center gap-[.4rem] font-mono text-[.72rem] text-muted transition-colors hover:text-teal"
      >
        ← All products
      </Link>

      <section className="mb-9 max-w-[46rem]">
        <p className="mb-[.8rem] font-mono text-[.68rem] uppercase tracking-[.14em] text-teal">
          Disruption · single points of failure
        </p>
        <h1 className="mb-[.55rem] text-[clamp(1.7rem,3.8vw,2.35rem)] font-bold leading-[1.1]">
          What stops when one link fails.
        </h1>
        <p className="m-0 text-muted">
          Pick a country to see what an export restriction would cut. A route counts as
          affected if <em>any</em> operation on it sits in that country — material merely
          refined there stops too.
        </p>
      </section>

      {global.status === 'error' && (
        <ErrorState message={global.message} onRetry={() => setReloadKey((k) => k + 1)} />
      )}

      {global.status === 'loading' && (
        <div className={PANEL}><LoadingState label="Loading risk view" rows={6} /></div>
      )}

      {global.status === 'ready' && (
        <div className="grid items-start gap-5 [grid-template-columns:minmax(0,1fr)] xl:[grid-template-columns:minmax(0,1fr)_26rem]">
          <div className="flex flex-col gap-5">
            <section className={PANEL}>
              <div className={PANEL_HEAD}>
                <h2 className={PANEL_TITLE}>Restrict exports from</h2>
                <span className="font-mono text-[.72rem] text-faint">
                  {global.countries.length} countries with operations
                </span>
              </div>
              <div className="flex flex-wrap gap-2 p-[1.1rem]">
                {global.countries.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => selectCountry(c.id)}
                    aria-pressed={country === c.id}
                    className={[
                      'cursor-pointer rounded border px-[.7rem] py-[.35rem] font-mono text-[.72rem] transition-colors',
                      country === c.id
                        ? 'border-teal bg-tealwash text-tealdeep'
                        : 'border-line bg-surface text-muted hover:border-teal hover:text-teal',
                    ].join(' ')}
                  >
                    {c.name}{' '}
                    <span className="text-faint">{c.operationCount}</span>
                  </button>
                ))}
              </div>
            </section>

            {detail.status === 'idle' && (
              <section className={PANEL}>
                <EmptyState
                  title="Pick a country"
                  detail="Choose one above to see which products stop, which are thinned, and which carry on unaffected."
                />
              </section>
            )}

            {detail.status === 'loading' && (
              <section className={PANEL}><LoadingState label="Calculating impact" rows={5} /></section>
            )}

            {detail.status === 'error' && (
              <section className={PANEL}>
                <ErrorState message={detail.message} />
              </section>
            )}

            {detail.status === 'ready' && (
              <section className={PANEL}>
                <div className={PANEL_HEAD}>
                  <h2 className={PANEL_TITLE}>
                    If {selectedName} restricts exports
                  </h2>
                  <span className="font-mono text-[.72rem] text-faint">
                    {detail.operations.length} operations there
                  </span>
                </div>

                {detail.impacts.length === 0 ? (
                  <EmptyState
                    title="Nothing traced"
                    detail="No product in the graph has a supply route that reaches this country."
                  />
                ) : (
                  <div className="flex flex-col">
                    {detail.impacts.map((i) => {
                      const s = SEVERITY[i.severity];
                      return (
                        <div
                          key={`${i.productId}|${i.mineralId}`}
                          className="flex flex-col gap-[.4rem] border-b border-linesoft px-[1.1rem] py-[.8rem] last:border-b-0"
                        >
                          <div className="flex items-center gap-[.55rem]">
                            <span className="rounded-[3px] border border-teal bg-tealwash px-[.42rem] py-[.16rem] font-mono text-[.72rem] font-semibold text-tealdeep">
                              {i.symbol}
                            </span>
                            <span className="text-[.95rem] font-semibold">{i.product}</span>
                            <span
                              className={`ml-auto rounded-[3px] px-[.45rem] py-[.14rem] font-mono text-[.62rem] uppercase tracking-[.08em] ${s.cls}`}
                            >
                              {s.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            {/* A bar rather than a bare percentage: the ratio of
                                cut routes to total is the whole finding. */}
                            <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-sunk">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.round(i.share * 100)}%`,
                                  background:
                                    i.severity === 'severed'
                                      ? 'var(--color-danger)'
                                      : 'var(--color-ochre)',
                                }}
                              />
                            </div>
                            <span className="font-mono text-[.68rem] tabular-nums text-muted">
                              {i.affectedRoutes} of {i.totalRoutes} {i.mineral.toLowerCase()} routes
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>

          <section className={PANEL}>
            <div className={PANEL_HEAD}>
              <h2 className={PANEL_TITLE}>Chokepoints</h2>
              <span className="font-mono text-[.72rem] text-faint">graph-wide</span>
            </div>
            <div className="px-[1.1rem] pt-[.9rem] pb-[.4rem]">
              <p className="m-0 text-[.86rem] text-muted">
                Intermediate operations ranked by how many origin-to-product routes pass
                through them. Nothing in the data stores this — it only exists as a
                property of how the paths overlap.
              </p>
            </div>
            <div className="flex flex-col">
              {global.chokepoints.slice(0, 8).map((c, idx) => (
                <div
                  key={c.operationId}
                  className="flex flex-col gap-[.35rem] border-b border-linesoft px-[1.1rem] py-[.7rem] last:border-b-0"
                >
                  <div className="flex items-baseline gap-[.55rem]">
                    <span className="font-mono text-[.7rem] text-faint tabular-nums">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span className="text-[.93rem] font-semibold">{c.site}</span>
                    <span className="font-mono text-[.64rem] uppercase tracking-[.08em] text-faint">
                      {c.type}
                    </span>
                    <span className="ml-auto font-mono text-[.72rem] tabular-nums text-ink">
                      {Math.round((c.routesThrough / Math.max(c.totalRoutes, 1)) * 100)}%
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-sunk">
                      <div
                        className="h-full rounded-full bg-teal"
                        style={{
                          width: `${Math.round((c.routesThrough / Math.max(c.totalRoutes, 1)) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="font-mono text-[.66rem] text-faint">
                      {c.routesThrough}/{c.totalRoutes}
                    </span>
                  </div>
                  <span className="font-mono text-[.66rem] text-muted">
                    {c.company ?? 'Unknown operator'} · {c.country}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
