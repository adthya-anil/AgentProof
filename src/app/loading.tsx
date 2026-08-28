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
    <div className="panel">
      <p className="note" style={{ margin: 0 }}>
        <span className="pulse">●</span> Loading the stored run…
      </p>
    </div>
  );
}
