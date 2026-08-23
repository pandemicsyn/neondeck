export function globalMap<K, V>(key: string): Map<K, V> {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const existing = target[key];
  if (existing instanceof Map) return existing as Map<K, V>;
  const registry = new Map<K, V>();
  target[key] = registry;
  return registry;
}
