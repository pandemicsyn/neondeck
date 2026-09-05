export function safeReference(path: string) {
  return (
    path.length < 500 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))
  );
}
