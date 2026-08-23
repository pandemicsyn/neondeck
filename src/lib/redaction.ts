const credentialName =
  '(?:(?:[a-z0-9]+[_-])*(?:api[_-]?key|auth[_-]?token|client[_-]?secret|credential|oauth[_-]?token|access[_-]?token|refresh[_-]?token|secret[_-]?access[_-]?key|access[_-]?key(?:[_-]?id)?|password|passwd|private[_-]?key|secret|token))';
const queryCredentialName = `(?:${credentialName}|auth|authorization)`;

/**
 * Redacts common credential shapes while preserving the surrounding text for
 * local diagnostics. This is intentionally shared by every surface that
 * retains or reports command/model output so their protections do not drift.
 */
export function redactSensitiveText(value: string) {
  return value
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
      '[redacted private key]',
    )
    .replace(
      /\b(authorization)(["']?)(\s*[:=]\s*)(["']?)((?:basic|bearer)\s+)[^\s,"';]+/gi,
      '$1$2$3$4$5[redacted]',
    )
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b([a-z][a-z\d+.-]*):\/\/[^/\s@]+@/gi, '$1://')
    .replace(
      new RegExp(`([?&]${queryCredentialName}=)[^&#\\s]+`, 'gi'),
      '$1[redacted]',
    )
    .replace(
      /\b(authorization)(["']?)(\s*[:=]\s*)(["'])(?!(?:basic|bearer)\s+\[redacted\])[^\r\n]*?\4/gi,
      '$1$2$3$4[redacted]$4',
    )
    .replace(
      /\b(authorization)(["']?)(\s*[:=]\s*)(?!(?:basic|bearer)\s+\[redacted\]|\[redacted\])[^\s"'\]}]+/gi,
      '$1$2$3[redacted]',
    )
    .replace(
      new RegExp(
        `^([\\t ]*(?:export[\\t ]+)?(["']?)${credentialName}\\2[\\t ]*[:=][\\t ]*)(?!["']|\\[redacted\\])[^\\r\\n]*$`,
        'gim',
      ),
      '$1[redacted]',
    )
    .replace(
      new RegExp(
        `\\b(${credentialName})(["']?)(\\s*[:=]\\s*)(["'])([^\\r\\n]*?)\\4`,
        'gi',
      ),
      '$1$2$3$4[redacted]$4',
    )
    .replace(
      new RegExp(
        `\\b(${credentialName})(["']?)(\\s*[:=]\\s*)(?!\\[redacted\\])[^\\s"'\\]}]+`,
        'gi',
      ),
      '$1$2$3[redacted]',
    )
    .replace(
      /\b(?:github_pat_[a-z0-9_]{20,}|gh[pousr]_[a-z0-9]{20,}|sk-(?:ant-)?[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/gi,
      '[redacted credential]',
    );
}
