import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AgentRunError, init, observe, type FlueEvent } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import {
  buildPrReviewAssistantRuntime,
  PrReviewAssistant,
} from '../../agents/pr-review-assistant';
import {
  prReviewAgentInitialDataSchema,
  reviewAssistStructuredOutputSchema,
} from '../../modules/pr-review-assist/schemas';
import { prReviewEvalScenario, type PrReviewEvalScenarioId } from './scenarios';

const fixtureSchema = v.strictObject({
  schema: v.literal('neondeck.pr-review-eval-fixture.v1'),
  scenario: v.string(),
  immutableRevision: v.strictObject({
    repoPath: v.pipe(v.string(), v.minLength(1)),
    headSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i)),
    baseSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i)),
    mergeBase: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i)),
  }),
  initialData: v.unknown(),
  message: v.optional(v.string()),
});

export type PrReviewEvalFixture = v.InferOutput<typeof fixtureSchema>;
const execFileAsync = promisify(execFile);

export type PrReviewEvalRun = Readonly<{
  fixture: PrReviewEvalFixture;
  provider: string;
  startedAt: string;
  finishedAt: string;
  outcome: 'completed' | 'failed' | 'aborted' | 'unknown';
  error: Readonly<{ name: string; message: string }> | null;
  replyText: string;
  finalReview: unknown | null;
  toolCalls: ReadonlyArray<Readonly<{ name: string; input: unknown }>>;
  observations: readonly FlueEvent[];
  promptHashes: readonly string[];
  models: ReadonlyArray<
    Readonly<{
      role: 'parent' | 'explore';
      provider: string;
      requested: string;
      response: string | null;
      thinkingLevel: string | null;
      usage: unknown;
    }>
  >;
}>;

export async function loadPrReviewEvalFixture(path: string) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  const fixture = v.parse(fixtureSchema, value);
  if (!prReviewEvalScenario(fixture.scenario)) {
    throw new Error(`Unknown PR-review eval scenario "${fixture.scenario}".`);
  }
  await validateImmutableFixtureBinding(fixture);
  return fixture as PrReviewEvalFixture;
}

export async function runPrReviewEval(input: {
  fixture: PrReviewEvalFixture;
  provider: string;
}): Promise<PrReviewEvalRun> {
  const startedAt = new Date().toISOString();
  const observedEvents: FlueEvent[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const persistedContext = v.parse(
    prReviewAgentInitialDataSchema,
    input.fixture.initialData,
  );
  // Fixtures own immutable review evidence and model selection, while the eval
  // always exercises the prompt currently installed in this checkout/runtime.
  const initialData = {
    ...persistedContext,
    instructions: buildPrReviewAssistantRuntime().instructions,
  };
  const flue = await start({ agents: [PrReviewAssistant] });
  try {
    // No id intentionally mints a new Flue conversation/attempt per eval.
    const agent = init(PrReviewAssistant);
    const unsubscribe = observe((event) => {
      observedEvents.push(event);
    });
    const receipt = await agent.dispatch({
      initialData,
      message: {
        kind: 'signal',
        type: 'neondeck.pr-review.requested',
        body:
          input.fixture.message ??
          'Run the immutable pull-request review fixture now.',
      },
    });
    let replyText = '';
    let outcome: PrReviewEvalRun['outcome'] = 'completed';
    let terminalError: PrReviewEvalRun['error'] = null;
    try {
      const reply = await agent.read(receipt, {
        onEvent(chunk) {
          if (chunk.type === 'tool-input') {
            toolCalls.push({ name: chunk.toolName, input: chunk.input });
          }
        },
      });
      replyText = reply.text;
    } catch (error) {
      outcome = error instanceof AgentRunError ? error.outcome : 'unknown';
      terminalError = {
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      unsubscribe();
    }
    const submit = toolCalls.findLast(
      (call) => call.name === 'neondeck_submit_pr_review',
    );
    const observations = observedEvents.filter(
      (event) => event.submissionId === receipt.submissionId,
    );
    const settlement = observations.findLast(
      (event) => event.type === 'submission_settled',
    );
    if (settlement?.type === 'submission_settled') {
      outcome = settlement.outcome;
    }
    return {
      fixture: input.fixture,
      provider: input.provider,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome,
      error: terminalError,
      replyText,
      finalReview: submit?.input ?? null,
      toolCalls,
      observations,
      promptHashes: observations.flatMap((event) =>
        event.type === 'turn_request' && event.request.input.systemPrompt
          ? [sha256(event.request.input.systemPrompt)]
          : event.type === 'task_start'
            ? [sha256(event.prompt)]
            : [],
      ),
      models: observations.flatMap((event) =>
        event.type === 'turn'
          ? [
              {
                role: event.taskId ? 'explore' : 'parent',
                provider: event.request.providerId,
                requested: event.request.requestedModel,
                response: event.response.responseModel ?? null,
                thinkingLevel: event.request.reasoningLevel ?? null,
                usage: event.response.usage ?? null,
              },
            ]
          : [],
      ),
    };
  } finally {
    await flue.stop();
  }
}

export async function writePrReviewEvalReport(
  run: PrReviewEvalRun,
  path = defaultReportPath(run),
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return path;
}

function defaultReportPath(run: PrReviewEvalRun) {
  const home = process.env.NEONDECK_HOME;
  if (!home) {
    throw new Error(
      'NEONDECK_HOME must be configured before writing a PR-review eval report.',
    );
  }
  const timestamp = run.startedAt.replace(/[:.]/g, '-');
  return join(
    home,
    'evals',
    'pr-review',
    `${run.fixture.scenario}-${timestamp}.json`,
  );
}

async function validateImmutableFixtureBinding(fixture: PrReviewEvalFixture) {
  const context = v.parse(prReviewAgentInitialDataSchema, fixture.initialData);
  if (!isAbsolute(fixture.immutableRevision.repoPath)) {
    throw new Error('Eval fixture repository path must be absolute.');
  }
  if (!context.workspace.available) {
    throw new Error(
      'Eval fixture initial data must bind an available exact-revision workspace.',
    );
  }
  const expected = fixture.immutableRevision;
  const mismatches = [
    resolve(context.workspace.repoPath) === resolve(expected.repoPath)
      ? null
      : 'repoPath',
    context.workspace.headSha.toLowerCase() === expected.headSha.toLowerCase()
      ? null
      : 'headSha',
    context.workspace.baseSha?.toLowerCase() === expected.baseSha.toLowerCase()
      ? null
      : 'baseSha',
    context.workspace.mergeBase?.toLowerCase() ===
    expected.mergeBase.toLowerCase()
      ? null
      : 'mergeBase',
    context.prepared.input.headSha &&
    context.prepared.input.headSha.toLowerCase() !==
      expected.headSha.toLowerCase()
      ? 'prepared.input.headSha'
      : null,
    context.prepared.input.baseSha &&
    context.prepared.input.baseSha.toLowerCase() !==
      expected.baseSha.toLowerCase()
      ? 'prepared.input.baseSha'
      : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new Error(
      `Eval fixture immutable revision does not match initial data: ${mismatches.join(', ')}.`,
    );
  }
  let resolvedHead: string;
  let resolvedBase: string;
  let resolvedMergeBase: string;
  try {
    [resolvedHead, resolvedBase] = await Promise.all([
      gitOutput(expected.repoPath, [
        'rev-parse',
        '--verify',
        `${expected.headSha}^{commit}`,
      ]),
      gitOutput(expected.repoPath, [
        'rev-parse',
        '--verify',
        `${expected.baseSha}^{commit}`,
      ]),
    ]);
    resolvedMergeBase = await gitOutput(expected.repoPath, [
      'merge-base',
      expected.headSha,
      expected.baseSha,
    ]);
  } catch (error) {
    throw new Error(
      `Eval fixture Git revision validation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const gitMismatches = [
    resolvedHead.toLowerCase() === expected.headSha.toLowerCase()
      ? null
      : 'headSha',
    resolvedBase.toLowerCase() === expected.baseSha.toLowerCase()
      ? null
      : 'baseSha',
    resolvedMergeBase.toLowerCase() === expected.mergeBase.toLowerCase()
      ? null
      : 'mergeBase',
  ].filter((value): value is string => value !== null);
  if (gitMismatches.length > 0) {
    throw new Error(
      `Eval fixture Git repository does not prove its declared immutable revision: ${gitMismatches.join(', ')}.`,
    );
  }
}

async function gitOutput(repoPath: string, args: string[]) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function assertPrReviewEvalContracts(run: PrReviewEvalRun) {
  const scenario = prReviewEvalScenario(run.fixture.scenario);
  if (!scenario) throw new Error('Fixture scenario is no longer registered.');
  const parsed = run.finalReview
    ? v.safeParse(reviewAssistStructuredOutputSchema, run.finalReview)
    : null;
  const taskCalls = run.toolCalls.filter((call) => call.name === 'task');
  const taskStarts = run.observations.filter(
    (event) => event.type === 'task_start',
  );
  const taskWaves = new Set(
    taskStarts.map((event) => event.turnId ?? event.timestamp),
  );

  return {
    scenario,
    finalReviewValid: parsed?.success === true,
    taskCount: taskCalls.length,
    taskWaveCount: taskWaves.size,
    hasParallelTaskWave: [...taskWaves].some(
      (wave) =>
        taskStarts.filter((event) => (event.turnId ?? event.timestamp) === wave)
          .length > 1,
    ),
    taskPrompts: taskCalls.map((call) =>
      typeof call.input === 'object' &&
      call.input !== null &&
      'prompt' in call.input
        ? String(call.input.prompt)
        : '',
    ),
    providerMatchesExpected:
      run.models.some((model) => model.role === 'parent') &&
      run.models
        .filter((model) => model.role === 'parent')
        .every((model) => model.provider === run.provider),
  };
}

export function scenarioIdFromFixture(
  fixture: PrReviewEvalFixture,
): PrReviewEvalScenarioId {
  return fixture.scenario as PrReviewEvalScenarioId;
}
