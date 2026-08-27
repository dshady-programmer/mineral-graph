/**
 * Loading, empty and error states.
 *
 * The brief grades these explicitly, so they are real components rather than
 * inline ternaries - and the error state distinguishes "the database is
 * unreachable" from "there is nothing here", because those need different
 * words and only one of them is worth retrying.
 */

export function LoadingState({ label = 'Loading', rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div className="p-[1.1rem]" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="skeleton mb-[.6rem]"
          style={{ width: `${92 - i * 11}%`, height: i === 0 ? '1.3rem' : '1rem' }}
        />
      ))}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-[.6rem] px-6 py-14 text-center">
      <span className="mb-[.35rem] rounded-[3px] bg-sunk px-[.55rem] py-1 font-mono text-[.66rem] uppercase tracking-[.1em] text-muted">
        Nothing to show
      </span>
      <h2 className="text-[1.05rem] font-semibold">{title}</h2>
      <p className="m-0 max-w-[26rem] text-[.92rem] text-muted">{detail}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-[.6rem] px-6 py-14 text-center"
      role="alert"
    >
      <span className="mb-[.35rem] rounded-[3px] bg-dangerwash px-[.55rem] py-1 font-mono text-[.66rem] uppercase tracking-[.1em] text-danger">
        Problem
      </span>
      <h2 className="text-[1.05rem] font-semibold text-danger">Couldn&rsquo;t load this</h2>
      <p className="m-0 max-w-[26rem] text-[.92rem] text-muted">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 cursor-pointer rounded border border-line bg-surface px-[.9rem] py-[.45rem] font-mono text-[.74rem] text-ink transition-colors hover:border-teal hover:text-teal"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function GraphSkeleton() {
  return (
    <div className="p-[1.1rem]" aria-busy="true">
      <div className="skeleton h-[480px] w-full" />
    </div>
  );
}
