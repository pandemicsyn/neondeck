import { describe, expect, it } from 'vitest';
import {
  createChatMessages,
  createDiffFiles,
  createDiffFixture,
} from './fixtures';

describe('frontend performance fixtures', () => {
  it('creates deterministic unified patches at the requested scale', () => {
    const fixture = createDiffFixture({ changedLines: 400, fileCount: 4 });

    expect(fixture.changedLines).toBe(400);
    expect(fixture.patch.match(/^diff --git/gm)).toHaveLength(4);
    expect(fixture.patch.match(/^[-+]export const/gm)).toHaveLength(400);
  });

  it('creates the Hunk-inspired 180-file tree tier', () => {
    const files = createDiffFiles(180, 120);

    expect(files).toHaveLength(180);
    expect(files[0]?.patch?.match(/^[-+]export const/gm)).toHaveLength(120);
  });

  it('creates markdown-heavy durable chat histories', () => {
    const messages = createChatMessages(500);

    expect(messages).toHaveLength(500);
    expect(messages[499]?.body).toContain('```ts');
    expect(messages[499]?.body).toContain('| path | status |');
  });
});
