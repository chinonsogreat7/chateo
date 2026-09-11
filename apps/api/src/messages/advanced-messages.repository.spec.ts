import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { messageFingerprint } from './message-mapping';
import { PrismaMessagesRepository } from './prisma-messages.repository';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const send = {
  conversationId: CHAT,
  senderId: USER,
  clientMessageId: CLIENT,
  text: 'Original',
  attachmentMediaIds: [],
  now: NOW,
};

function setup() {
  const row = {
    id: ID,
    conversationId: CHAT,
    senderId: USER,
    clientMessageId: CLIENT,
    kind: 'TEXT',
    text: 'Original' as string | null,
    attachments: [],
    reactions: [] as Array<{ userId: string; emoji: string }>,
    createdAt: NOW,
    replyToMessageId: null as string | null,
    editedAt: null as Date | null,
    deletedAt: null as Date | null,
    version: 0,
    sendFingerprint: null as string | null,
  };
  const members = [USER, OTHER].map((userId) => ({
    userId,
    clearedAt: null as Date | null,
    clearedThroughMessageId: null as string | null,
  }));
  const client = {
    conversation: {
      findUnique: jest.fn().mockResolvedValue({ type: 'DIRECT', members }),
      updateMany: jest.fn(),
    },
    userBlock: { findFirst: jest.fn().mockResolvedValue(null) },
    conversationMember: {
      findUnique: jest.fn().mockResolvedValue(members[0]),
      findMany: jest.fn().mockResolvedValue(members),
      updateMany: jest.fn(),
    },
    message: {
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
      create: jest.fn().mockResolvedValue(row),
      update: jest.fn(
        async ({
          data,
        }: {
          data: {
            text?: string | null;
            editedAt?: Date;
            deletedAt?: Date;
            sendFingerprint: string;
            version: { increment: number };
          };
        }) => {
          if (data.text !== undefined) row.text = data.text;
          row.editedAt = data.editedAt ?? row.editedAt;
          row.deletedAt = data.deletedAt ?? row.deletedAt;
          row.sendFingerprint = data.sendFingerprint;
          row.version += data.version.increment;
          return { ...row };
        },
      ),
    },
    messageReaction: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn(),
    },
    mediaAsset: { updateMany: jest.fn(), findMany: jest.fn() },
  };
  const transaction = jest.fn(
    async (callback: (value: typeof client) => Promise<unknown>) =>
      callback(client),
  );
  return {
    row,
    members,
    client,
    transaction,
    repository: new PrismaMessagesRepository({
      ...client,
      $transaction: transaction,
    } as unknown as PrismaService),
  };
}

describe('Advanced message persistence', () => {
  it('edits atomically, increments version, preserves the original send fingerprint, and safely replays sends', async () => {
    const { repository, row, client, transaction } = setup();
    const input = {
      conversationId: CHAT,
      actorId: USER,
      messageId: ID,
      now: NOW,
      mutation: { kind: 'edit' as const, text: 'Edited', expectedVersion: 0 },
    };
    await expect(repository.mutate(input)).resolves.toMatchObject({
      status: 'updated',
      changed: true,
      event: {
        kind: 'updated',
        message: { text: 'Edited', version: 1, editedAt: NOW },
      },
    });
    expect(row.sendFingerprint).toBe(messageFingerprint(send));
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    await expect(repository.mutate(input)).resolves.toMatchObject({
      status: 'updated',
      changed: false,
    });
    await expect(
      repository.mutate({
        ...input,
        mutation: { ...input.mutation, text: 'Stale overwrite' },
      }),
    ).resolves.toEqual({ status: 'version-conflict' });
    expect(client.message.update).toHaveBeenCalledTimes(1);
    await expect(repository.send(send)).resolves.toMatchObject({
      status: 'existing',
      message: { text: 'Edited', version: 1 },
    });
    await expect(
      repository.send({ ...send, text: 'Different' }),
    ).resolves.toEqual({ status: 'idempotency-conflict' });
  });

  it('deletes text and reactions but keeps a stable, idempotent placeholder', async () => {
    const { repository, row, client } = setup();
    row.reactions = [{ userId: OTHER, emoji: '👍' }];
    const input = {
      conversationId: CHAT,
      actorId: USER,
      messageId: ID,
      now: NOW,
      mutation: { kind: 'delete' as const },
    };
    await expect(repository.mutate(input)).resolves.toMatchObject({
      changed: true,
      event: {
        kind: 'deleted',
        message: {
          text: null,
          deletedAt: NOW,
          attachments: [],
          reactions: [],
          version: 1,
        },
      },
    });
    expect(client.messageReaction.deleteMany).toHaveBeenCalledWith({
      where: { messageId: ID },
    });
    expect(row.text).toBeNull();
    await expect(repository.send(send)).resolves.toMatchObject({
      status: 'existing',
      message: { text: null, deletedAt: NOW },
    });
    await expect(repository.mutate(input)).resolves.toMatchObject({
      changed: false,
    });
    await expect(
      repository.mutate({
        ...input,
        mutation: { kind: 'reaction', emoji: '👍' },
      }),
    ).resolves.toEqual({ status: 'deleted' });
    expect(client.conversationMember.updateMany).not.toHaveBeenCalled();
  });

  it('sets/replaces/removes only the acting user reaction and suppresses no-ops', async () => {
    const { repository, row, client } = setup();
    const input = {
      conversationId: CHAT,
      actorId: OTHER,
      messageId: ID,
      now: NOW,
      mutation: { kind: 'reaction' as const, emoji: '👍' },
    };
    await expect(repository.mutate(input)).resolves.toMatchObject({
      changed: true,
      event: { kind: 'reaction-updated', actorId: OTHER },
    });
    expect(client.messageReaction.upsert).toHaveBeenCalledWith({
      where: { messageId_userId: { messageId: ID, userId: OTHER } },
      create: { messageId: ID, userId: OTHER, emoji: '👍', updatedAt: NOW },
      update: { emoji: '👍', updatedAt: NOW },
    });
    row.reactions = [{ userId: OTHER, emoji: '👍' }];
    await expect(repository.mutate(input)).resolves.toMatchObject({
      changed: false,
    });
    await repository.mutate({
      ...input,
      mutation: { kind: 'reaction', emoji: null },
    });
    expect(client.messageReaction.deleteMany).toHaveBeenCalledWith({
      where: { messageId: ID, userId: OTHER },
    });
  });

  it.each(['edit', 'delete'] as const)(
    'rejects %s from a different sender',
    async (kind) => {
      const { repository, client } = setup();
      await expect(
        repository.mutate({
          conversationId: CHAT,
          actorId: OTHER,
          messageId: ID,
          now: NOW,
          mutation:
            kind === 'edit'
              ? { kind, text: 'Oops', expectedVersion: 0 }
              : { kind },
        }),
      ).resolves.toEqual({ status: 'forbidden' });
      expect(client.message.update).not.toHaveBeenCalled();
    },
  );

  it('checks blocks before mutation and applies clear boundaries to target lookup', async () => {
    const { repository, client, members } = setup();
    const input = {
      conversationId: CHAT,
      actorId: USER,
      messageId: ID,
      now: NOW,
      mutation: { kind: 'delete' as const },
    };
    client.userBlock.findFirst.mockResolvedValueOnce({ blockerId: OTHER });
    await expect(repository.mutate(input)).resolves.toEqual({
      status: 'message-not-found',
    });
    expect(client.message.findFirst).not.toHaveBeenCalled();
    members[0]!.clearedAt = NOW;
    members[0]!.clearedThroughMessageId = ID;
    client.message.findFirst.mockResolvedValue(null);
    await expect(repository.mutate(input)).resolves.toEqual({
      status: 'message-not-found',
    });
    expect(client.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: ID,
          conversationId: CHAT,
          OR: [{ createdAt: { gt: NOW } }, { createdAt: NOW, id: { gt: ID } }],
        },
      }),
    );
  });

  it('rejects hidden/cross-conversation/deleted reply targets before claiming media or creating messages', async () => {
    const { repository, client } = setup();
    client.message.findUnique.mockResolvedValue(null);
    client.message.findFirst.mockResolvedValue(null);
    await expect(
      repository.send({ ...send, replyToMessageId: ID }),
    ).resolves.toEqual({ status: 'reply-unavailable' });
    expect(client.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ID, conversationId: CHAT, deletedAt: null },
      }),
    );
    expect(client.message.create).not.toHaveBeenCalled();
    expect(client.mediaAsset.updateMany).not.toHaveBeenCalled();
  });

  it('searches literal text/captions inside membership and clear boundaries, excluding tombstones', async () => {
    const { repository, client } = setup();
    await repository.listForMember(
      CHAT,
      USER,
      { createdAt: NOW, id: ID },
      11,
      '50%_off',
    );
    expect(client.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversationId: CHAT,
          deletedAt: null,
          text: { contains: '50\\%\\_off', mode: 'insensitive' },
        }),
        take: 11,
      }),
    );
    client.conversationMember.findMany.mockResolvedValue([]);
    await expect(
      repository.listForMember(CHAT, USER, null, 11, 'term'),
    ).resolves.toEqual({ status: 'conversation-not-found' });
    expect(client.message.findMany).toHaveBeenCalledTimes(1);
  });
});
