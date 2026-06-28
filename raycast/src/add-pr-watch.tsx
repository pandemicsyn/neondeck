import { Action, ActionPanel, Form, popToRoot } from '@raycast/api';
import {
  type DesiredTerminalState,
  addPrWatch,
  withNeondeckToast,
} from './neondeck';

type Values = {
  ref: string;
  desiredTerminalState: DesiredTerminalState;
};

export default function Command() {
  async function submit(values: Values) {
    await withNeondeckToast('Adding PR watch', () =>
      addPrWatch(values.ref.trim(), values.desiredTerminalState),
    );
    await popToRoot();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add PR Watch" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="ref"
        title="PR"
        placeholder="repo#123, owner/repo#123, or GitHub PR URL"
      />
      <Form.Dropdown
        id="desiredTerminalState"
        title="Until"
        defaultValue="checks"
      >
        <Form.Dropdown.Item value="checks" title="Checks" />
        <Form.Dropdown.Item value="merged" title="Merged" />
        <Form.Dropdown.Item value="prod" title="Production" />
      </Form.Dropdown>
    </Form>
  );
}
