import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendMessageDto } from './send-message.dto';

const CLIENT_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const ATTACHMENT_ID = '66666666-6666-4666-8666-666666666666';

describe('SendMessageDto', () => {
  it.each([
    { text: '  Hello!  ' },
    { attachmentMediaIds: [ATTACHMENT_ID] },
    { text: 'Caption', attachmentMediaIds: [ATTACHMENT_ID] },
  ])('accepts a message with usable content: %p', async (content) => {
    const input = plainToInstance(SendMessageDto, {
      clientMessageId: CLIENT_MESSAGE_ID,
      ...content,
    });

    await expect(validate(input)).resolves.toEqual([]);
  });

  it.each([
    {},
    { text: '' },
    { text: '   ' },
    { text: null },
    { attachmentMediaIds: [] },
  ])('rejects a message without text or attachments: %p', async (content) => {
    const input = plainToInstance(SendMessageDto, {
      clientMessageId: CLIENT_MESSAGE_ID,
      ...content,
    });

    const errors = await validate(input);

    expect(
      errors.some((error) => error.property === 'attachmentMediaIds'),
    ).toBe(true);
  });

  it('does not silently discard an invalid non-string caption', async () => {
    const input = plainToInstance(SendMessageDto, {
      clientMessageId: CLIENT_MESSAGE_ID,
      text: 123,
      attachmentMediaIds: [ATTACHMENT_ID],
    });

    const errors = await validate(input);

    expect(
      errors.find((error) => error.property === 'text')?.constraints,
    ).toHaveProperty('isString');
  });

  it('rejects attachment IDs duplicated with different casing', async () => {
    const input = plainToInstance(SendMessageDto, {
      clientMessageId: CLIENT_MESSAGE_ID,
      attachmentMediaIds: [ATTACHMENT_ID, ATTACHMENT_ID.toUpperCase()],
    });

    const errors = await validate(input);

    expect(
      errors.find((error) => error.property === 'attachmentMediaIds')
        ?.constraints,
    ).toHaveProperty('arrayUnique');
  });

  it('limits one message to ten attachments', async () => {
    const attachmentMediaIds = Array.from(
      { length: 11 },
      (_, index) =>
        `66666666-6666-4666-8666-${(index + 1).toString().padStart(12, '0')}`,
    );
    const input = plainToInstance(SendMessageDto, {
      clientMessageId: CLIENT_MESSAGE_ID,
      attachmentMediaIds,
    });

    const errors = await validate(input);

    expect(
      errors.find((error) => error.property === 'attachmentMediaIds')
        ?.constraints,
    ).toHaveProperty('arrayMaxSize');
  });
});
