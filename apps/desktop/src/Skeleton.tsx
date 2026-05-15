/// Pulse-animated row skeletons used by panels while their initial fetch
/// is in flight. Keeps shape parity with the real list rows so the layout
/// doesn't jump on data arrival.

export function SkeletonRow({
  height = 56,
  className = "",
}: {
  height?: number;
  className?: string;
}) {
  return (
    <div
      role="presentation"
      aria-hidden
      style={{ height }}
      className={`mb-2 flex animate-pulse flex-col gap-2 rounded-md bg-ink-2/60 px-3 py-2.5 ${className}`}
    >
      <div className="h-3 w-1/3 rounded-sm bg-ink-3" />
      <div className="h-2.5 w-2/3 rounded-sm bg-ink-3/70" />
      <div className="mt-auto flex items-center gap-2">
        <div className="h-3 w-12 rounded-sm bg-ink-3/60" />
        <div className="h-3 w-12 rounded-sm bg-ink-3/60" />
      </div>
    </div>
  );
}

export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
