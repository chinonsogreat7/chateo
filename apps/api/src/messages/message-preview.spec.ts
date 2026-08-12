import {
  MAX_MESSAGE_PREVIEW_CODE_POINTS,
  messagePreview,
} from './message-preview';

describe('messagePreview', () => {
  it('preserves text at the Unicode code-point limit', () => {
    const text = '👋'.repeat(MAX_MESSAGE_PREVIEW_CODE_POINTS);

    expect(messagePreview(text)).toBe(text);
  });

  it('truncates overlong text to 119 code points and an ellipsis', () => {
    const text = '👋'.repeat(MAX_MESSAGE_PREVIEW_CODE_POINTS + 1);
    const preview = messagePreview(text);

    expect(preview).toBe(
      `${'👋'.repeat(MAX_MESSAGE_PREVIEW_CODE_POINTS - 1)}…`,
    );
    expect(Array.from(preview)).toHaveLength(MAX_MESSAGE_PREVIEW_CODE_POINTS);
  });
});
