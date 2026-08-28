/**
 * Shown while a server component is still working.
 *
 * The report pages execute a real preflight run on request. That is fast, but
 * "fast" is not "instant", and without this the browser shows an empty black
 * page and looks hung — which is exactly how it was reported.
 */
export default function Loading() {
  return (
    <div className="panel" style={{ marginTop: "1.5rem" }}>
      <h2>Running preflight…</h2>
      <p className="note" style={{ marginBottom: 0 }}>
        Executing buyer journeys against the merchant and evaluating every
        invariant. This runs live rather than reading a cached result, so the
        numbers you see belong to a run that just happened.
      </p>
    </div>
  );
}
