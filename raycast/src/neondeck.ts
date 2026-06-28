import { Toast, getPreferenceValues, showToast } from '@raycast/api';

type Preferences = {
  neondeckUrl: string;
};

export type DesiredTerminalState = 'checks' | 'merged' | 'prod';

type NeondeckActionResult = {
  ok: boolean;
  message?: string;
  errors?: string[];
  requires?: string[];
};

export function githubPullRequestFromText(value: string) {
  const match = value.match(
    /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?/i,
  );
  return match?.[0];
}

export async function addPrWatch(
  ref: string,
  desiredTerminalState: DesiredTerminalState,
) {
  const command =
    desiredTerminalState === 'checks'
      ? `/watch-pr ${ref}`
      : `/watch-pr ${ref} until ${desiredTerminalState}`;
  const result = await postNeondeck<NeondeckActionResult>(
    '/api/flue/workflows/command-run?wait=result',
    { input: { command } },
  );

  if (!result.ok) {
    throw new Error(resultMessage(result, 'Could not add PR watch.'));
  }

  return result;
}

export async function addRefWatch(input: {
  repo?: string;
  ref?: string;
  target?: string;
  intervalSeconds?: number;
}) {
  const result = await postNeondeck<NeondeckActionResult>(
    '/api/watches/ref',
    input,
  );

  if (!result.ok) {
    throw new Error(resultMessage(result, 'Could not add ref watch.'));
  }

  return result;
}

export async function withNeondeckToast<T>(
  title: string,
  operation: () => Promise<T>,
) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title,
  });

  try {
    const result = await operation();
    toast.style = Toast.Style.Success;
    toast.title = 'Neondeck watch added';
    toast.message = successMessage(result);
    return result;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = 'Neondeck request failed';
    toast.message = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function postNeondeck<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T;

  if (!response.ok) {
    const result = data as NeondeckActionResult;
    throw new Error(
      resultMessage(result, `Neondeck returned HTTP ${response.status}.`),
    );
  }

  return data;
}

function baseUrl() {
  const preferences = getPreferenceValues<Preferences>();
  return preferences.neondeckUrl.replace(/\/+$/, '');
}

function resultMessage(result: NeondeckActionResult, fallback: string) {
  return (
    [
      result.message,
      result.errors?.join('; '),
      result.requires?.length
        ? `Requires: ${result.requires.join(', ')}`
        : null,
    ]
      .filter((item): item is string => Boolean(item))
      .join(' ')
      .trim() || fallback
  );
}

function successMessage(result: unknown) {
  if (result && typeof result === 'object' && 'message' in result) {
    const message = (result as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }

  return 'Saved in Neondeck.';
}
