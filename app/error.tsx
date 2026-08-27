'use client';

import { useEffect } from 'react';

/**
 * React error boundary for this route segment.
 *
 * The API layer already turns driver failures into typed responses, and each
 * page renders an ErrorState for those. This catches the other half: an
 * exception thrown while RENDERING - a malformed payload, an unexpected null,
 * a bug in the graph component. Without it, Next.js shows its own error screen
 * in development and a blank page in production, which is the worst possible
 * outcome for a graded demo.
 *
 * `reset()` re-renders the segment without a full page reload, so a transient
 * failure costs the viewer nothing.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side digest only; the message itself is never shown to the user,
    // because a raw stack trace can leak connection details.
    console.error('[render error]', error);
  }, [error]);

  return (
    <main
      className="flex flex-col items-center justify-center gap-[.6rem] px-6 py-20 text-center"
      role="alert"
    >
      <span className="mb-[.35rem] rounded-[3px] bg-dangerwash px-[.55rem] py-1 font-mono text-[.66rem] uppercase tracking-[.1em] text-danger">
        Unexpected error
      </span>
      <h2 className="text-[1.15rem] font-semibold text-danger">Something broke while rendering</h2>
      <p className="m-0 max-w-[28rem] text-[.92rem] text-muted">
        This is a bug rather than a connection problem. Trying again will re-render the page;
        if it keeps happening the details are in the server logs.
      </p>
      {error.digest && (
        <p className="m-0 font-mono text-[.7rem] text-faint">Reference: {error.digest}</p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-2 cursor-pointer rounded border border-line bg-surface px-[.9rem] py-[.45rem] font-mono text-[.74rem] text-ink transition-colors hover:border-teal hover:text-teal"
      >
        Try again
      </button>
    </main>
  );
}
