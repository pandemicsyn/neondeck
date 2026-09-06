import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import type * as v from 'valibot';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { artifactHash, readBytesBounded } from '../coding-runs';
import { executionResult } from '../execution';
import type { candidateReviewResultSchema } from './reviewer-contract';

/** Paths are selected from validated retained records, never from the request. */
export async function readBoundEvidenceJson(
  ref: string,
  root: string,
  digest: string,
  limit = 1048576,
) {
  const rel = relative(resolve(root), resolve(ref));
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  )
    throw new Error('Receipt escapes retained directory');
  const realRoot = await realpath(root);
  const realRef = await realpath(ref);
  const actual = relative(realRoot, realRef);
  if (actual !== rel) throw new Error('Receipt path traverses a symbolic link');
  const bytes = await readBytesBounded(ref, limit);
  if (artifactHash(bytes) !== digest)
    throw new Error('Evidence content digest mismatch');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
export function sanitizeEvidenceText(
  value: string,
  paths: RuntimePaths,
  max = 4000,
) {
  // Reuse execution token redaction before applying display-only privacy bounds.
  let text = executionResult({
    stdout: value,
    stderr: '',
    exitCode: 0,
    durationMs: 0,
    outputLimit: 1048576,
  }).stdout;
  for (const root of [paths.home, homedir()])
    if (root.length > 1) text = text.split(root).join('[local path]');
  text = text.replace(
    new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g'),
    '',
  );
  text = [...text]
    .filter(
      (char) =>
        char === '\n' ||
        char === '\t' ||
        (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    )
    .join('');
  text = text
    .replace(
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi,
      '[redacted authorization]',
    )
    .replace(
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization|cookie)\b["']?\s*[:=]\s*(?:["'][^"'\r\n]*["']|[^\s,;]+)/gi,
      '[redacted credential]',
    )
    .replace(
      /(?:\/(?:Users|home|private|tmp|var|root|Volumes|mnt)\/[^\s"'<>]+)/g,
      '[local path]',
    )
    .replace(/[A-Za-z]:\\(?:Users|Windows|Temp)\\[^\s"'<>]+/g, '[local path]');
  return {
    text: text.slice(0, max),
    truncated: text.length > max || value.length > 1048576,
  };
}
export async function readRetainedEvidenceReceipt(
  p: DeliveryPipeline,
  ref: string,
  paths: RuntimePaths,
) {
  const root = join(paths.home, 'factory-delivery', p.pipelineId);
  if (
    resolve(dirname(ref)) !== resolve(root) ||
    !/^[a-f0-9]{64}\.json$/.test(basename(ref))
  )
    throw new Error('Invalid retained receipt identity');
  return readBoundEvidenceJson(ref, root, basename(ref, '.json'));
}
export function renderEvidenceFindings(
  source: v.InferOutput<typeof candidateReviewResultSchema>['findings'],
  paths: RuntimePaths,
) {
  let truncated = source.length > 20;
  const findings = source.slice(0, 20).map((finding) => {
    const description = sanitizeEvidenceText(finding.description, paths, 2000);
    const path =
      isAbsolute(finding.path) ||
      /^[A-Za-z]:[\\/]/.test(finding.path) ||
      finding.path.split(/[\\/]/).includes('..')
        ? null
        : sanitizeEvidenceText(finding.path, paths, 500).text;
    truncated ||= description.truncated;
    return {
      severity: finding.severity,
      path,
      line: finding.line,
      description: description.text,
    };
  });
  return { findings, truncated };
}
