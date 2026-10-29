import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGroupConversationDto } from './create-group-conversation.dto';
import { UpdateGroupConversationDto } from './update-group-conversation.dto';

describe('group descriptions', () => {
  const options = { whitelist: true, forbidNonWhitelisted: true };
  const create = {
    name: 'Study group',
    participantIds: ['00000000-0000-4000-8000-000000000001'],
  };

  it('accepts and trims a description on creation and metadata updates', async () => {
    const input = plainToInstance(CreateGroupConversationDto, {
      ...create,
      description: '  React Native classroom  ',
    });
    const update = plainToInstance(UpdateGroupConversationDto, {
      description: '  Project discussion  ',
    });
    expect(await validate(input, options)).toEqual([]);
    expect(await validate(update, options)).toEqual([]);
    expect(input).toMatchObject({ description: 'React Native classroom' });
    expect(update).toMatchObject({ description: 'Project discussion' });
  });

  it.each([null, '', '   '])(
    'allows clearing the description with %j',
    async (description) => {
      expect(
        await validate(
          plainToInstance(UpdateGroupConversationDto, { description }),
          options,
        ),
      ).toEqual([]);
    },
  );

  it.each(['x'.repeat(501), 123, true, {}])(
    'rejects invalid description %j',
    async (description) => {
      expect(
        (
          await validate(
            plainToInstance(CreateGroupConversationDto, {
              ...create,
              description,
            }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (
          await validate(
            plainToInstance(UpdateGroupConversationDto, { description }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);
    },
  );
});
