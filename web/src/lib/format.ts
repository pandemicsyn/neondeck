export function relativeTime(
  value: string,
  options: { suffix?: boolean } = {},
) {
  const timestamp = Date.parse(value);
  const delta = Date.now() - timestamp;
  if (!Number.isFinite(delta)) return 'now';

  const future = delta < 0;
  const minutes = Math.floor(Math.abs(delta) / 60_000);
  const compact =
    minutes < 1
      ? future
        ? 'soon'
        : 'now'
      : minutes < 60
        ? `${minutes}m`
        : minutes < 2_880
          ? `${Math.floor(minutes / 60)}h`
          : `${Math.floor(minutes / 1_440)}d`;

  if (future) return options.suffix ? `in ${compact}` : compact;
  return options.suffix && compact !== 'now' ? `${compact} ago` : compact;
}
