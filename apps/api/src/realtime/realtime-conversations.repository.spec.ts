import { PrismaService } from '../database/prisma.service';
import { PrismaRealtimeConversationsRepository } from './realtime-conversations.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

function createRepository() {
  const conversationFindFirst = jest.fn();
  const blockFindFirst = jest.fn().mockResolvedValue(null);
  const repository = new PrismaRealtimeConversationsRepository({
    conversation: { findFirst: conversationFindFirst },
    userBlock: { findFirst: blockFindFirst },
  } as unknown as PrismaService);
  return { repository, conversationFindFirst, blockFindFirst };
}

describe('PrismaRealtimeConversationsRepository', () => {
  it('returns active direct participants when neither user has blocked the other', async () => {
    const { repository, conversationFindFirst, blockFindFirst } =
      createRepository();
    conversationFindFirst.mockResolvedValue({
      id: CONVERSATION_ID,
      type: 'DIRECT',
      members: [{ userId: USER_ID }, { userId: OTHER_USER_ID }],
    });

    await expect(
      repository.findAccessibleConversation(CONVERSATION_ID, USER_ID),
    ).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      participantIds: [USER_ID, OTHER_USER_ID],
    });
    expect(blockFindFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: USER_ID, blockedId: OTHER_USER_ID },
          { blockerId: OTHER_USER_ID, blockedId: USER_ID },
        ],
      },
      select: { blockerId: true },
    });
  });

  it('conceals direct realtime access when either user has blocked the other', async () => {
    const { repository, conversationFindFirst, blockFindFirst } =
      createRepository();
    conversationFindFirst.mockResolvedValue({
      id: CONVERSATION_ID,
      type: 'DIRECT',
      members: [{ userId: USER_ID }, { userId: OTHER_USER_ID }],
    });
    blockFindFirst.mockResolvedValue({ blockerId: OTHER_USER_ID });

    await expect(
      repository.findAccessibleConversation(CONVERSATION_ID, USER_ID),
    ).resolves.toBeNull();
  });

  it('keeps group access independent of direct user blocks', async () => {
    const { repository, conversationFindFirst, blockFindFirst } =
      createRepository();
    conversationFindFirst.mockResolvedValue({
      id: CONVERSATION_ID,
      type: 'GROUP',
      members: [{ userId: USER_ID }, { userId: OTHER_USER_ID }],
    });

    await expect(
      repository.findAccessibleConversation(CONVERSATION_ID, USER_ID),
    ).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      participantIds: [USER_ID, OTHER_USER_ID],
    });
    expect(blockFindFirst).not.toHaveBeenCalled();
  });

  it('loads one current group roster for lifecycle fan-out and cache refresh', async () => {
    const { repository, conversationFindFirst } = createRepository();
    conversationFindFirst.mockResolvedValue({
      members: [{ userId: USER_ID }, { userId: OTHER_USER_ID }],
    });

    await expect(
      repository.findGroupParticipantIds(CONVERSATION_ID),
    ).resolves.toEqual([USER_ID, OTHER_USER_ID]);
    expect(conversationFindFirst).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID, type: 'GROUP' },
      select: {
        members: {
          select: { userId: true },
          orderBy: { userId: 'asc' },
        },
      },
    });
  });
});
