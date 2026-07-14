import * as v from 'valibot';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

export type RepoGuardrails = {
  maxFilesChanged: number;
  maxLinesChanged: number;
  deniedFileGlobs: string[];
  approvalRequiredFileGlobs: string[];
  requiredChecks: string[];
  allowedPushDestinations: string[];
  allowForcePush: boolean;
  highRiskClasses: string[];
  generatedFileSizeThresholdBytes: number;
};

export type RepoGuardrailsConfig = Partial<RepoGuardrails>;

export const repoGuardrailsSchema = v.looseObject({
  maxFilesChanged: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxLinesChanged: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  deniedFileGlobs: v.optional(v.array(nonEmptyStringSchema)),
  approvalRequiredFileGlobs: v.optional(v.array(nonEmptyStringSchema)),
  requiredChecks: v.optional(v.array(nonEmptyStringSchema)),
  allowedPushDestinations: v.optional(v.array(nonEmptyStringSchema)),
  allowForcePush: v.optional(v.boolean()),
  highRiskClasses: v.optional(v.array(nonEmptyStringSchema)),
  generatedFileSizeThresholdBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
});

export const defaultRepoGuardrails: RepoGuardrails = {
  maxFilesChanged: 12,
  maxLinesChanged: 500,
  deniedFileGlobs: [
    '.git/**',
    '.env*',
    '**/.env*',
    '*.{pem,key,p12,pfx}',
    '**/*.{pem,key,p12,pfx}',
    '**/*secret*',
  ],
  approvalRequiredFileGlobs: [
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/bun.lock',
    '**/Cargo.lock',
    '**/package.json',
    '.github/**',
    '.gitlab-ci.yml',
    '**/migrations/**',
    '**/*.{png,jpg,jpeg,gif,webp,zip}',
    'vendor/**',
    '**/vendor/**',
    'third_party/**',
    '**/third_party/**',
  ],
  requiredChecks: [],
  allowedPushDestinations: ['pull-request-head'],
  allowForcePush: false,
  highRiskClasses: [
    'lockfile',
    'dependency-manifest',
    'ci-config',
    'deployment-config',
    'security-sensitive-code',
    'secrets-env',
    'database-migration',
    'large-generated-file',
    'binary-file',
    'vendored-code',
    'repo-glob',
  ],
  generatedFileSizeThresholdBytes: 256 * 1024,
};
