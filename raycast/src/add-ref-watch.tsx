import { Action, ActionPanel, Form, popToRoot } from '@raycast/api';
import { addRefWatch, withNeondeckToast } from './neondeck';

type Values = {
  target: string;
  intervalSeconds?: string;
};

export default function Command() {
  async function submit(values: Values) {
    const intervalSeconds = values.intervalSeconds?.trim()
      ? Number(values.intervalSeconds.trim())
      : undefined;

    if (intervalSeconds !== undefined && !Number.isFinite(intervalSeconds)) {
      throw new Error('Interval must be a number of seconds.');
    }

    await withNeondeckToast('Adding ref watch', () =>
      addRefWatch({
        target: values.target.trim(),
        ...(intervalSeconds ? { intervalSeconds } : {}),
      }),
    );
    await popToRoot();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Ref Watch" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="target"
        title="Ref"
        placeholder="repo@branch, owner/repo@sha, or GitHub tree/commit URL"
      />
      <Form.TextField
        id="intervalSeconds"
        title="Poll Interval"
        placeholder="Optional seconds, minimum 60"
      />
    </Form>
  );
}
