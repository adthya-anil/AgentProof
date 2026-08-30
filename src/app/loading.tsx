/**
 * Route-level loading state.
 *
 * Every report page is a dynamic server component. They are fast now — they read
 * a stored run rather than executing one — but "fast" is not "instant", and
 * without this file Next renders nothing at all while a server component
 * resolves. A blank page reads as broken; a blank page that stays blank for two
 * seconds reads as hung. Neither is true, and both are avoidable.
 */
export default function Loading() {
  return (
    <div className="panel loading-panel" role="status" aria-busy="true">
      <div className="loading-indicator" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div>
        <strong>Loading dashboard</strong>
        <p className="note">Reading the latest stored run…</p>
      </div>
    </div>
  );
}
