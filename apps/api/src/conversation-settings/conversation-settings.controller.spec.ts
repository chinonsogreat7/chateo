import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { ConversationSettingsController } from './conversation-settings.controller';
import { ConversationSettingsService } from './conversation-settings.service';
import { ConversationMuteDuration } from './dto/mute-conversation.dto';

const USER = {
  sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as AuthenticatedUser;
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESPONSE = {
  conversationId: CONVERSATION_ID,
  archived: false,
  muted: false,
  pinned: false,
  favorited: false,
  archivedAt: null,
  mutedAt: null,
  mutedUntil: null,
  pinnedAt: null,
  favoritedAt: null,
  clearedAt: null,
  clearedThroughMessageId: null,
};

function createController() {
  const service = {
    update: jest.fn().mockResolvedValue(RESPONSE),
    mute: jest.fn().mockResolvedValue(RESPONSE),
    unmute: jest.fn().mockResolvedValue(RESPONSE),
    setFavorite: jest.fn().mockResolvedValue(RESPONSE),
    setArchived: jest.fn().mockResolvedValue(RESPONSE),
  } as unknown as jest.Mocked<ConversationSettingsService>;
  return {
    service,
    controller: new ConversationSettingsController(service),
  };
}

describe('ConversationSettingsController', () => {
  it('passes the requested mute duration to the service', async () => {
    const { controller, service } = createController();

    await expect(
      controller.mute(
        USER,
        { conversationId: CONVERSATION_ID },
        { duration: ConversationMuteDuration.SevenDays },
      ),
    ).resolves.toBe(RESPONSE);
    expect(service.mute).toHaveBeenCalledWith(
      USER.sub,
      CONVERSATION_ID,
      ConversationMuteDuration.SevenDays,
    );
  });

  it('delegates unmute to the signed-in member settings', async () => {
    const { controller, service } = createController();

    await expect(
      controller.unmute(USER, { conversationId: CONVERSATION_ID }),
    ).resolves.toBe(RESPONSE);
    expect(service.unmute).toHaveBeenCalledWith(USER.sub, CONVERSATION_ID);
  });

  it.each([
    ['archive', true],
    ['unarchive', false],
  ] as const)(
    'delegates %s to the signed-in member settings',
    async (method, enabled) => {
      const { controller, service } = createController();

      await expect(
        controller[method](USER, { conversationId: CONVERSATION_ID }),
      ).resolves.toBe(RESPONSE);
      expect(service.setArchived).toHaveBeenCalledWith(
        USER.sub,
        CONVERSATION_ID,
        enabled,
      );
    },
  );

  it.each([
    ['favorite', true],
    ['unfavorite', false],
  ] as const)(
    'delegates %s to the signed-in member settings',
    async (method, enabled) => {
      const { controller, service } = createController();

      await expect(
        controller[method](USER, { conversationId: CONVERSATION_ID }),
      ).resolves.toBe(RESPONSE);
      expect(service.setFavorite).toHaveBeenCalledWith(
        USER.sub,
        CONVERSATION_ID,
        enabled,
      );
    },
  );
});
