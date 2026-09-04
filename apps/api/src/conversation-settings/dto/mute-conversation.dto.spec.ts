import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ConversationMuteDuration,
  MuteConversationDto,
} from './mute-conversation.dto';

describe('MuteConversationDto', () => {
  it.each(Object.values(ConversationMuteDuration))(
    'accepts the %s duration',
    async (duration) => {
      const input = plainToInstance(MuteConversationDto, { duration });

      await expect(validate(input)).resolves.toEqual([]);
    },
  );

  it.each([undefined, null, 'one_hour', 8])(
    'rejects the unsupported duration %p',
    async (duration) => {
      const input = plainToInstance(MuteConversationDto, { duration });

      const errors = await validate(input);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe('duration');
      expect(errors[0]?.constraints).toHaveProperty('isEnum');
    },
  );
});
