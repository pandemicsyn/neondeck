export function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-line bg-field px-2 py-1">
      <span className="text-primary">{value}</span>
      <span className="ml-1">{label}</span>
    </div>
  );
}

export function StatusPill({
  label,
  ok,
  value,
}: {
  label: string;
  ok: boolean;
  value: string;
}) {
  return (
    <div className="border border-line bg-field px-2 py-1">
      <span className={ok ? 'text-primary' : 'text-accent'}>{value}</span>
      <span className="ml-1">{label}</span>
    </div>
  );
}

export function MiniEmpty({ label }: { label: string }) {
  return (
    <div className="border border-line bg-soft px-2.5 py-2 font-mono text-[10px] text-muted">
      {label}
    </div>
  );
}
