export function upsertCommandEvent<T extends { id: string }>(
  events: T[],
  event: T,
  limit = 30,
) {
  const existingIndex = events.findIndex((item) => item.id === event.id);
  if (existingIndex < 0) return [...events, event].slice(-limit);

  const nextEvents = [...events];
  nextEvents[existingIndex] = event;
  return nextEvents.slice(-limit);
}
