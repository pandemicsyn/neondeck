import { Clipboard, getSelectedText } from '@raycast/api';
import {
  addPrWatch,
  githubPullRequestFromText,
  withNeondeckToast,
} from './neondeck';

export default async function Command() {
  const selectedText = await getSelectedText().catch(() => '');
  const clipboardText = await Clipboard.readText().catch(() => '');
  const prUrl = githubPullRequestFromText(`${selectedText}\n${clipboardText}`);

  if (!prUrl) {
    throw new Error('Select or copy a GitHub PR URL first.');
  }

  await withNeondeckToast('Adding PR watch', () => addPrWatch(prUrl, 'checks'));
}
