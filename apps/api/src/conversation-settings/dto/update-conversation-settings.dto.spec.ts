import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateConversationSettingsDto } from './update-conversation-settings.dto';

const SETTING_FIELDS = ['archived', 'muted', 'pinned'] as const;

describe('UpdateConversationSettingsDto', () => {
  it('allows settings to be omitted', async () => {
    const input = plainToInstance(UpdateConversationSettingsDto, {});

    await expect(validate(input)).resolves.toEqual([]);
  });

  it.each(SETTING_FIELDS)('rejects explicit null for %s', async (field) => {
    const input = plainToInstance(UpdateConversationSettingsDto, {
      [field]: null,
    });

    const errors = await validate(input);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe(field);
    expect(errors[0]?.constraints).toHaveProperty('isBoolean');
  });

  it.each(SETTING_FIELDS)('accepts boolean values for %s', async (field) => {
    const enabled = plainToInstance(UpdateConversationSettingsDto, {
      [field]: true,
    });
    const disabled = plainToInstance(UpdateConversationSettingsDto, {
      [field]: false,
    });

    await expect(validate(enabled)).resolves.toEqual([]);
    await expect(validate(disabled)).resolves.toEqual([]);
  });
});
