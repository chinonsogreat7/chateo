import { MediaPurpose, MediaStatus, MessageKind, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrismaMessagesRepository } from './prisma-messages.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION_ID = '33333333-3333-4333-8333-333333333334';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const CLIENT_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const ATTACHMENT_ONE_ID = '66666666-6666-4666-8666-666666666666';
const ATTACHMENT_TWO_ID = '77777777-7777-4777-8777-777777777777';
const AUDIO_ATTACHMENT_ID = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-08-12T16:00:00.000Z');

function rawMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    senderId: USER_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    kind: MessageKind.TEXT,
    text: 'Hello!',
    attachments: [],
    createdAt: NOW,
    ...overrides,
  };
}

function sendInput() {
  return {
    conversationId: CONVERSATION_ID,
    senderId: USER_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    text: 'Hello!',
    now: NOW,
  };
}

function rawAttachment(mediaAssetId: string, position: number) {
  return {
    mediaAssetId,
    position,
    mediaAsset: {
      resourceType: 'image',
      deliveryType: 'upload',
      format: 'jpg',
      mimeType: 'image/jpeg',
      byteSize: 245000,
      width: 640,
      height: 480,
      durationMs: null,
      secureUrl: `https://res.cloudinary.com/demo/image/upload/${mediaAssetId}.jpg`,
    },
  };
}

function rawAudioAttachment(
  mediaAssetId = AUDIO_ATTACHMENT_ID,
  overrides: Record<string, unknown> = {},
) {
  return {
    mediaAssetId,
    position: 0,
    mediaAsset: {
      resourceType: 'video',
      deliveryType: 'upload',
      format: 'm4a',
      mimeType: 'audio/mp4',
      byteSize: 512000,
      width: null,
      height: null,
      durationMs: 32000,
      secureUrl: `https://res.cloudinary.com/demo/video/upload/${mediaAssetId}.m4a`,
      ...overrides,
    },
  };
}

function readyImageAsset(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    cloudinaryAssetId: `cloudinary-${id}`,
    resourceType: 'image',
    deliveryType: 'upload',
    format: 'jpg',
    mimeType: 'image/jpeg',
    byteSize: 245000,
    width: 640,
    height: 480,
    durationMs: null,
    secureUrl: `https://res.cloudinary.com/demo/image/upload/${id}.jpg`,
    completedAt: NOW,
    messageClaimedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function readyAudioAsset(
  id = AUDIO_ATTACHMENT_ID,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    cloudinaryAssetId: `cloudinary-${id}`,
    resourceType: 'video',
    deliveryType: 'upload',
    format: 'm4a',
    mimeType: 'audio/mp4',
    byteSize: 512000,
    width: null,
    height: null,
    durationMs: 32000,
    secureUrl: `https://res.cloudinary.com/demo/video/upload/${id}.m4a`,
    completedAt: NOW,
    messageClaimedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function imageSendInput(
  attachmentMediaIds = [ATTACHMENT_ONE_ID, ATTACHMENT_TWO_ID],
) {
  return {
    conversationId: CONVERSATION_ID,
    senderId: USER_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    text: null,
    attachmentMediaIds,
    now: NOW,
  };
}

function audioSendInput() {
  return {
    conversationId: CONVERSATION_ID,
    senderId: USER_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    text: null,
    attachmentMediaIds: [AUDIO_ATTACHMENT_ID],
    now: NOW,
  };
}

function audioSendInputWithIds(attachmentMediaIds: string[]) {
  return { ...audioSendInput(), attachmentMediaIds };
}

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    clientVersion: '6.19.3',
    code,
  });
}

function createRepository() {
  const memberFindMany = jest.fn();
  const conversationFindUnique = jest.fn().mockResolvedValue({
    type: 'DIRECT',
    members: [
      { userId: USER_ID, clearedAt: null },
      { userId: OTHER_USER_ID, clearedAt: null },
    ],
  });
  const blockFindFirst = jest.fn().mockResolvedValue(null);
  const messageFindUnique = jest.fn();
  const messageFindMany = jest.fn();
  const mediaAssetFindMany = jest.fn();
  const transaction = jest
    .fn()
    .mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversationMember: { findMany: memberFindMany },
          message: { findMany: messageFindMany },
        }),
    );
  const prisma = {
    $transaction: transaction,
    conversationMember: { findMany: memberFindMany },
    conversation: { findUnique: conversationFindUnique },
    userBlock: { findFirst: blockFindFirst },
    message: { findUnique: messageFindUnique, findMany: messageFindMany },
    mediaAsset: { findMany: mediaAssetFindMany },
  } as unknown as PrismaService;
  return {
    repository: new PrismaMessagesRepository(prisma),
    transaction,
    memberFindMany,
    conversationFindUnique,
    blockFindFirst,
    messageFindUnique,
    messageFindMany,
    mediaAssetFindMany,
  };
}

function sendTransactionState(existing: unknown = null) {
  const conversationFindUnique = jest.fn().mockResolvedValue({
    type: 'DIRECT',
    members: [
      { userId: USER_ID, clearedAt: null },
      { userId: OTHER_USER_ID, clearedAt: null },
    ],
  });
  const blockFindFirst = jest.fn().mockResolvedValue(null);
  const messageFindUnique = jest.fn().mockResolvedValue(existing);
  const messageCreate = jest.fn().mockResolvedValue(rawMessage());
  const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const memberUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const mediaAssetUpdateMany = jest.fn();
  const mediaAssetFindMany = jest
    .fn()
    .mockResolvedValue([
      readyImageAsset(ATTACHMENT_ONE_ID),
      readyImageAsset(ATTACHMENT_TWO_ID),
    ]);
  const client = {
    conversationMember: {
      updateMany: memberUpdateMany,
    },
    userBlock: { findFirst: blockFindFirst },
    message: { findUnique: messageFindUnique, create: messageCreate },
    mediaAsset: {
      findMany: mediaAssetFindMany,
      updateMany: mediaAssetUpdateMany,
    },
    conversation: {
      findUnique: conversationFindUnique,
      updateMany: conversationUpdateMany,
    },
  };
  return {
    client,
    conversationFindUnique,
    blockFindFirst,
    messageFindUnique,
    messageCreate,
    conversationUpdateMany,
    memberUpdateMany,
    mediaAssetFindMany,
    mediaAssetUpdateMany,
  };
}

describe('PrismaMessagesRepository', () => {
  it('updates activity and unread state without unarchiving recipients', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toEqual({
      status: 'created',
      message: {
        ...rawMessage(),
        participantIds: [USER_ID, OTHER_USER_ID],
      },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(state.messageCreate).toHaveBeenCalledWith({
      data: {
        conversationId: CONVERSATION_ID,
        senderId: USER_ID,
        clientMessageId: CLIENT_MESSAGE_ID,
        kind: MessageKind.TEXT,
        text: 'Hello!',
        createdAt: NOW,
      },
      select: expect.any(Object),
    });
    expect(state.conversationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: CONVERSATION_ID,
        lastActivityAt: { lt: NOW },
      },
      data: { lastActivityAt: NOW, updatedAt: NOW },
    });
    expect(state.memberUpdateMany).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        userId: { not: USER_ID },
      },
      data: { unreadCount: { increment: 1 } },
    });
  });

  it('places a new message after every member clear timestamp under clock skew', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    const createdAt = new Date(NOW.getTime() + 1);
    state.conversationFindUnique.mockResolvedValue({
      type: 'DIRECT',
      members: [
        { userId: USER_ID, clearedAt: NOW },
        { userId: OTHER_USER_ID, clearedAt: null },
      ],
    });
    state.messageCreate.mockResolvedValue(rawMessage({ createdAt }));
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toMatchObject({
      status: 'created',
      message: { createdAt },
    });
    expect(state.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdAt }),
      }),
    );
    expect(state.conversationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: CONVERSATION_ID,
        lastActivityAt: { lt: createdAt },
      },
      data: { lastActivityAt: createdAt, updatedAt: createdAt },
    });
  });

  it('atomically claims ready owned image assets in caller order', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    const attachments = [
      rawAttachment(ATTACHMENT_ONE_ID, 0),
      rawAttachment(ATTACHMENT_TWO_ID, 1),
    ];
    state.mediaAssetUpdateMany.mockResolvedValue({ count: 2 });
    state.messageCreate.mockResolvedValue(
      rawMessage({
        kind: MessageKind.IMAGE,
        text: null,
        attachments,
      }),
    );
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.send(imageSendInput())).resolves.toEqual({
      status: 'created',
      message: {
        ...rawMessage({
          kind: MessageKind.IMAGE,
          text: null,
          attachments: [
            {
              mediaId: ATTACHMENT_ONE_ID,
              type: 'image',
              contentType: 'image/jpeg',
              sizeBytes: 245000,
              width: 640,
              height: 480,
              url: `https://res.cloudinary.com/demo/image/upload/${ATTACHMENT_ONE_ID}.jpg`,
            },
            {
              mediaId: ATTACHMENT_TWO_ID,
              type: 'image',
              contentType: 'image/jpeg',
              sizeBytes: 245000,
              width: 640,
              height: 480,
              url: `https://res.cloudinary.com/demo/image/upload/${ATTACHMENT_TWO_ID}.jpg`,
            },
          ],
        }),
        participantIds: [USER_ID, OTHER_USER_ID],
      },
    });
    expect(state.mediaAssetUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [ATTACHMENT_ONE_ID, ATTACHMENT_TWO_ID] },
        ownerId: USER_ID,
        purpose: MediaPurpose.MESSAGE_ATTACHMENT,
        status: MediaStatus.READY,
        resourceType: 'image',
        deliveryType: 'upload',
        cloudinaryAssetId: { not: null },
        format: { in: ['jpg', 'jpeg', 'png', 'webp'] },
        mimeType: { in: ['image/jpeg', 'image/png', 'image/webp'] },
        byteSize: { gt: 0 },
        width: { gt: 0 },
        height: { gt: 0 },
        secureUrl: { not: null },
        completedAt: { not: null },
        messageClaimedAt: null,
        deletedAt: null,
        messageAttachments: { none: {} },
      },
      data: { messageClaimedAt: NOW },
    });
    expect(state.messageCreate).toHaveBeenCalledWith({
      data: {
        conversationId: CONVERSATION_ID,
        senderId: USER_ID,
        clientMessageId: CLIENT_MESSAGE_ID,
        kind: MessageKind.IMAGE,
        text: null,
        createdAt: NOW,
        attachments: {
          create: [
            { mediaAssetId: ATTACHMENT_ONE_ID, position: 0 },
            { mediaAssetId: ATTACHMENT_TWO_ID, position: 1 },
          ],
        },
      },
      select: expect.any(Object),
    });
  });

  it('derives and atomically persists one ready audio attachment', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    state.mediaAssetFindMany.mockResolvedValue([readyAudioAsset()]);
    state.mediaAssetUpdateMany.mockResolvedValue({ count: 1 });
    state.messageCreate.mockResolvedValue(
      rawMessage({
        kind: MessageKind.AUDIO,
        text: 'Listen to this',
        attachments: [rawAudioAttachment()],
      }),
    );
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(
      repository.send({ ...audioSendInput(), text: 'Listen to this' }),
    ).resolves.toEqual({
      status: 'created',
      message: {
        ...rawMessage({
          kind: MessageKind.AUDIO,
          text: 'Listen to this',
          attachments: [
            {
              mediaId: AUDIO_ATTACHMENT_ID,
              type: 'audio',
              contentType: 'audio/mp4',
              sizeBytes: 512000,
              durationMs: 32000,
              url: `https://res.cloudinary.com/demo/video/upload/${AUDIO_ATTACHMENT_ID}.m4a`,
            },
          ],
        }),
        participantIds: [USER_ID, OTHER_USER_ID],
      },
    });
    expect(state.mediaAssetFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: [AUDIO_ATTACHMENT_ID] },
        ownerId: USER_ID,
        purpose: MediaPurpose.MESSAGE_ATTACHMENT,
        status: MediaStatus.READY,
        deliveryType: 'upload',
        cloudinaryAssetId: { not: null },
        byteSize: { gt: 0 },
        secureUrl: { not: null },
        completedAt: { not: null },
        messageClaimedAt: null,
        deletedAt: null,
        messageAttachments: { none: {} },
      },
      select: expect.any(Object),
    });
    expect(state.mediaAssetUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { in: [AUDIO_ATTACHMENT_ID] },
        ownerId: USER_ID,
        purpose: MediaPurpose.MESSAGE_ATTACHMENT,
        status: MediaStatus.READY,
        resourceType: 'video',
        deliveryType: 'upload',
        byteSize: { gt: 0, lte: 20 * 1024 * 1024 },
        width: null,
        height: null,
        durationMs: { gt: 0, lte: 900000 },
        OR: [
          { mimeType: 'audio/aac', format: 'aac' },
          { mimeType: 'audio/mp4', format: 'm4a' },
          { mimeType: 'audio/m4a', format: 'm4a' },
          { mimeType: 'audio/x-m4a', format: 'm4a' },
          { mimeType: 'audio/mpeg', format: 'mp3' },
          { mimeType: 'audio/ogg', format: 'ogg' },
          { mimeType: 'audio/wav', format: 'wav' },
          { mimeType: 'audio/x-wav', format: 'wav' },
        ],
      }),
      data: { messageClaimedAt: NOW },
    });
    expect(state.messageCreate).toHaveBeenCalledWith({
      data: {
        conversationId: CONVERSATION_ID,
        senderId: USER_ID,
        clientMessageId: CLIENT_MESSAGE_ID,
        kind: MessageKind.AUDIO,
        text: 'Listen to this',
        createdAt: NOW,
        attachments: {
          create: [{ mediaAssetId: AUDIO_ATTACHMENT_ID, position: 0 }],
        },
      },
      select: expect.any(Object),
    });
  });

  it.each([
    ['audio/aac', 'aac'],
    ['audio/mp4', 'm4a'],
    ['audio/m4a', 'm4a'],
    ['audio/x-m4a', 'm4a'],
    ['audio/mpeg', 'mp3'],
    ['audio/ogg', 'ogg'],
    ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'],
  ])(
    'accepts the verified audio MIME/format pair %s -> %s',
    async (mimeType, format) => {
      const { repository, transaction } = createRepository();
      const state = sendTransactionState();
      state.mediaAssetFindMany.mockResolvedValue([
        readyAudioAsset(AUDIO_ATTACHMENT_ID, { mimeType, format }),
      ]);
      state.mediaAssetUpdateMany.mockResolvedValue({ count: 1 });
      state.messageCreate.mockResolvedValue(
        rawMessage({
          kind: MessageKind.AUDIO,
          text: null,
          attachments: [
            rawAudioAttachment(AUDIO_ATTACHMENT_ID, { mimeType, format }),
          ],
        }),
      );
      transaction.mockImplementation(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(state.client),
      );

      await expect(repository.send(audioSendInput())).resolves.toMatchObject({
        status: 'created',
        message: {
          kind: MessageKind.AUDIO,
          attachments: [{ type: 'audio', contentType: mimeType }],
        },
      });
    },
  );

  it.each([
    {
      name: 'a mismatched audio MIME/format pair',
      ids: [AUDIO_ATTACHMENT_ID],
      assets: [readyAudioAsset(AUDIO_ATTACHMENT_ID, { format: 'mp3' })],
    },
    {
      name: 'audio beyond the duration limit',
      ids: [AUDIO_ATTACHMENT_ID],
      assets: [readyAudioAsset(AUDIO_ATTACHMENT_ID, { durationMs: 900001 })],
    },
    {
      name: 'zero-duration audio',
      ids: [AUDIO_ATTACHMENT_ID],
      assets: [readyAudioAsset(AUDIO_ATTACHMENT_ID, { durationMs: 0 })],
    },
    {
      name: 'audio beyond the byte-size limit',
      ids: [AUDIO_ATTACHMENT_ID],
      assets: [
        readyAudioAsset(AUDIO_ATTACHMENT_ID, {
          byteSize: 20 * 1024 * 1024 + 1,
        }),
      ],
    },
    {
      name: 'more than one audio attachment',
      ids: [ATTACHMENT_ONE_ID, ATTACHMENT_TWO_ID],
      assets: [
        readyAudioAsset(ATTACHMENT_ONE_ID),
        readyAudioAsset(ATTACHMENT_TWO_ID),
      ],
    },
    {
      name: 'mixed image and audio attachments',
      ids: [ATTACHMENT_ONE_ID, AUDIO_ATTACHMENT_ID],
      assets: [
        readyImageAsset(ATTACHMENT_ONE_ID),
        readyAudioAsset(AUDIO_ATTACHMENT_ID),
      ],
    },
  ])(
    'rejects $name with the generic unavailable result',
    async ({ ids, assets }) => {
      const { repository, transaction } = createRepository();
      const state = sendTransactionState();
      state.mediaAssetFindMany.mockResolvedValue(assets);
      transaction.mockImplementation(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(state.client),
      );

      await expect(
        repository.send(audioSendInputWithIds(ids)),
      ).resolves.toEqual({ status: 'attachment-unavailable' });
      expect(state.mediaAssetUpdateMany).not.toHaveBeenCalled();
      expect(state.messageCreate).not.toHaveBeenCalled();
    },
  );

  it('resolves an identical image replay before block and availability checks', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState(
      rawMessage({
        kind: MessageKind.IMAGE,
        text: null,
        attachments: [
          rawAttachment(ATTACHMENT_ONE_ID, 0),
          rawAttachment(ATTACHMENT_TWO_ID, 1),
        ],
      }),
    );
    state.blockFindFirst.mockResolvedValue({ blockerId: OTHER_USER_ID });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.send(imageSendInput())).resolves.toMatchObject({
      status: 'existing',
      message: { id: MESSAGE_ID, kind: 'IMAGE' },
    });
    expect(state.blockFindFirst).not.toHaveBeenCalled();
    expect(state.mediaAssetUpdateMany).not.toHaveBeenCalled();
  });

  it('resolves an identical audio replay before block and availability checks', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState(
      rawMessage({
        kind: MessageKind.AUDIO,
        text: null,
        attachments: [rawAudioAttachment()],
      }),
    );
    state.blockFindFirst.mockResolvedValue({ blockerId: OTHER_USER_ID });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.send(audioSendInput())).resolves.toMatchObject({
      status: 'existing',
      message: { id: MESSAGE_ID, kind: 'AUDIO' },
    });
    expect(state.blockFindFirst).not.toHaveBeenCalled();
    expect(state.mediaAssetFindMany).not.toHaveBeenCalled();
    expect(state.mediaAssetUpdateMany).not.toHaveBeenCalled();
  });

  it('treats attachment order as part of the idempotent message data', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState(
      rawMessage({
        kind: MessageKind.IMAGE,
        text: null,
        attachments: [
          rawAttachment(ATTACHMENT_TWO_ID, 0),
          rawAttachment(ATTACHMENT_ONE_ID, 1),
        ],
      }),
    );
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.send(imageSendInput())).resolves.toEqual({
      status: 'idempotency-conflict',
    });
    expect(state.blockFindFirst).not.toHaveBeenCalled();
    expect(state.mediaAssetUpdateMany).not.toHaveBeenCalled();
  });

  it('returns an existing identical message despite a later block', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState(rawMessage());
    state.blockFindFirst.mockResolvedValue({ blockerId: OTHER_USER_ID });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toMatchObject({
      status: 'existing',
      message: { id: MESSAGE_ID },
    });
    expect(state.messageCreate).not.toHaveBeenCalled();
    expect(state.conversationUpdateMany).not.toHaveBeenCalled();
    expect(state.memberUpdateMany).not.toHaveBeenCalled();
    expect(state.blockFindFirst).not.toHaveBeenCalled();
  });

  it.each([
    rawMessage({ text: 'Different' }),
    rawMessage({ conversationId: OTHER_CONVERSATION_ID }),
  ])(
    'rejects an idempotency key reused with different data',
    async (existing) => {
      const { repository, transaction } = createRepository();
      const state = sendTransactionState(existing);
      transaction.mockImplementation(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(state.client),
      );

      await expect(repository.sendText(sendInput())).resolves.toEqual({
        status: 'idempotency-conflict',
      });
      expect(state.messageCreate).not.toHaveBeenCalled();
    },
  );

  it('returns the indistinguishable not-found result for a non-member', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    state.conversationFindUnique.mockResolvedValue({
      type: 'DIRECT',
      members: [{ userId: OTHER_USER_ID }],
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toEqual({
      status: 'conversation-not-found',
    });
    expect(state.messageFindUnique).not.toHaveBeenCalled();
    expect(state.messageCreate).not.toHaveBeenCalled();
  });

  it('conceals a direct conversation when either participant has blocked the other', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    state.blockFindFirst.mockResolvedValue({ blockerId: OTHER_USER_ID });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toEqual({
      status: 'conversation-not-found',
    });
    expect(state.messageFindUnique).toHaveBeenCalled();
    expect(state.messageCreate).not.toHaveBeenCalled();
  });

  it('retries serializable write conflicts with a bounded attempt count', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState(rawMessage());
    transaction
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockImplementationOnce(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(state.client),
      );

    await expect(repository.sendText(sendInput())).resolves.toMatchObject({
      status: 'existing',
    });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('reads the concurrent winner after a unique conflict', async () => {
    const { repository, transaction, blockFindFirst, messageFindUnique } =
      createRepository();
    transaction.mockRejectedValueOnce(knownRequestError('P2002'));
    messageFindUnique.mockResolvedValue(rawMessage());
    blockFindFirst.mockResolvedValue({ blockerId: OTHER_USER_ID });

    await expect(repository.sendText(sendInput())).resolves.toMatchObject({
      status: 'existing',
      message: { id: MESSAGE_ID },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(messageFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          senderId_clientMessageId: {
            senderId: USER_ID,
            clientMessageId: CLIENT_MESSAGE_ID,
          },
        },
      }),
    );
    expect(blockFindFirst).not.toHaveBeenCalled();
  });

  it('reads an identical image winner before rechecking its permanent claim', async () => {
    const { repository, transaction, messageFindUnique, mediaAssetFindMany } =
      createRepository();
    transaction.mockRejectedValueOnce(knownRequestError('P2002'));
    messageFindUnique.mockResolvedValue(
      rawMessage({
        kind: MessageKind.IMAGE,
        text: null,
        attachments: [
          rawAttachment(ATTACHMENT_ONE_ID, 0),
          rawAttachment(ATTACHMENT_TWO_ID, 1),
        ],
      }),
    );

    await expect(repository.send(imageSendInput())).resolves.toMatchObject({
      status: 'existing',
      message: { id: MESSAGE_ID, kind: 'IMAGE' },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(mediaAssetFindMany).not.toHaveBeenCalled();
  });

  it('maps a send racing with group membership removal to conversation-not-found', async () => {
    const {
      repository,
      transaction,
      conversationFindUnique,
      messageFindUnique,
    } = createRepository();
    transaction.mockRejectedValueOnce(knownRequestError('P2003'));
    conversationFindUnique.mockResolvedValue({
      type: 'GROUP',
      members: [{ userId: OTHER_USER_ID }],
    });

    await expect(repository.sendText(sendInput())).resolves.toEqual({
      status: 'conversation-not-found',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(messageFindUnique).not.toHaveBeenCalled();
  });

  it('rolls back a partial permanent claim when any attachment is unavailable', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    state.mediaAssetUpdateMany.mockResolvedValue({ count: 1 });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.send(imageSendInput())).resolves.toEqual({
      status: 'attachment-unavailable',
    });
    expect(state.mediaAssetUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { messageClaimedAt: NOW },
      }),
    );
    expect(state.messageCreate).not.toHaveBeenCalled();
    expect(state.conversationUpdateMany).not.toHaveBeenCalled();
    expect(state.memberUpdateMany).not.toHaveBeenCalled();
  });

  it('maps a concurrent unique attachment claim to attachment-unavailable', async () => {
    const { repository, transaction, messageFindUnique, mediaAssetFindMany } =
      createRepository();
    transaction.mockRejectedValueOnce(knownRequestError('P2002'));
    messageFindUnique.mockResolvedValue(null);
    mediaAssetFindMany.mockResolvedValue([readyImageAsset(ATTACHMENT_ONE_ID)]);

    await expect(repository.send(imageSendInput())).resolves.toEqual({
      status: 'attachment-unavailable',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(mediaAssetFindMany).toHaveBeenCalledTimes(1);
  });

  it('maps an attachment foreign-key race to attachment-unavailable', async () => {
    const { repository, transaction, mediaAssetFindMany } = createRepository();
    transaction.mockRejectedValueOnce(knownRequestError('P2003'));
    mediaAssetFindMany.mockResolvedValue([]);

    await expect(repository.send(imageSendInput())).resolves.toEqual({
      status: 'attachment-unavailable',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(mediaAssetFindMany).toHaveBeenCalledTimes(1);
  });

  it('uses stable newest-first keyset pagination after membership validation', async () => {
    const { repository, transaction, memberFindMany, messageFindMany } =
      createRepository();
    memberFindMany.mockResolvedValue([
      { userId: USER_ID, clearedAt: null, clearedThroughMessageId: null },
      {
        userId: OTHER_USER_ID,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    ]);
    messageFindMany.mockResolvedValue([rawMessage()]);
    const cursor = {
      createdAt: new Date('2026-08-12T15:00:00.000Z'),
      id: MESSAGE_ID,
    };

    await expect(
      repository.listForMember(CONVERSATION_ID, USER_ID, cursor, 51),
    ).resolves.toMatchObject({ status: 'found' });
    expect(messageFindMany).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        AND: [
          {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          },
        ],
      },
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });

  it('returns audio metadata in message history', async () => {
    const { repository, memberFindMany, messageFindMany } = createRepository();
    memberFindMany.mockResolvedValue([
      { userId: USER_ID, clearedAt: null, clearedThroughMessageId: null },
      {
        userId: OTHER_USER_ID,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    ]);
    messageFindMany.mockResolvedValue([
      rawMessage({
        kind: MessageKind.AUDIO,
        text: null,
        attachments: [rawAudioAttachment()],
      }),
    ]);

    await expect(
      repository.listForMember(CONVERSATION_ID, USER_ID, null, 51),
    ).resolves.toEqual({
      status: 'found',
      messages: [
        {
          ...rawMessage({
            kind: MessageKind.AUDIO,
            text: null,
            attachments: [
              {
                mediaId: AUDIO_ATTACHMENT_ID,
                type: 'audio',
                contentType: 'audio/mp4',
                sizeBytes: 512000,
                durationMs: 32000,
                url: `https://res.cloudinary.com/demo/video/upload/${AUDIO_ATTACHMENT_ID}.m4a`,
              },
            ],
          }),
          participantIds: [USER_ID, OTHER_USER_ID],
        },
      ],
    });
  });

  it('only returns messages newer than the requesting member clear boundary', async () => {
    const { repository, memberFindMany, messageFindMany } = createRepository();
    memberFindMany.mockResolvedValue([
      {
        userId: USER_ID,
        clearedAt: NOW,
        clearedThroughMessageId: MESSAGE_ID,
      },
      {
        userId: OTHER_USER_ID,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    ]);
    messageFindMany.mockResolvedValue([]);

    await expect(
      repository.listForMember(CONVERSATION_ID, USER_ID, null, 51),
    ).resolves.toEqual({ status: 'found', messages: [] });
    expect(messageFindMany).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        AND: [
          {
            OR: [
              { createdAt: { gt: NOW } },
              { createdAt: NOW, id: { gt: MESSAGE_ID } },
            ],
          },
        ],
      },
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
  });

  it('does not query history for a missing membership', async () => {
    const { repository, memberFindMany, messageFindMany } = createRepository();
    memberFindMany.mockResolvedValue([]);

    await expect(
      repository.listForMember(CONVERSATION_ID, USER_ID, null, 51),
    ).resolves.toEqual({ status: 'conversation-not-found' });
    expect(messageFindMany).not.toHaveBeenCalled();
  });

  it('sets unread count to zero and stores a read boundary transactionally', async () => {
    const { repository, transaction } = createRepository();
    const latestMessageAt = new Date('2026-08-12T16:01:00.000Z');
    const memberFindUnique = jest
      .fn()
      .mockResolvedValue({ conversationId: CONVERSATION_ID, lastReadAt: null });
    const messageFindFirst = jest
      .fn()
      .mockResolvedValue({ createdAt: latestMessageAt });
    const memberUpdate = jest.fn().mockResolvedValue({
      conversationId: CONVERSATION_ID,
      lastReadAt: latestMessageAt,
      unreadCount: 0,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversationMember: {
            findUnique: memberFindUnique,
            update: memberUpdate,
          },
          message: { findFirst: messageFindFirst },
        }),
    );

    await expect(
      repository.markRead(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toEqual({
      status: 'updated',
      state: {
        conversationId: CONVERSATION_ID,
        lastReadAt: latestMessageAt,
        unreadCount: 0,
      },
    });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: {
        conversationId_userId: {
          conversationId: CONVERSATION_ID,
          userId: USER_ID,
        },
      },
      data: { unreadCount: 0, lastReadAt: latestMessageAt },
      select: { conversationId: true, lastReadAt: true, unreadCount: true },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('sets only the requesting member clear boundary and resets unread state', async () => {
    const { repository, transaction } = createRepository();
    const latestMessageAt = new Date('2026-08-12T15:59:00.000Z');
    const memberFindUnique = jest.fn().mockResolvedValue({
      clearedAt: null,
      clearedThroughMessageId: null,
      unreadCount: 2,
    });
    const memberUpdate = jest.fn().mockResolvedValue({});
    const messageFindFirst = jest.fn().mockResolvedValue({
      id: MESSAGE_ID,
      createdAt: latestMessageAt,
    });
    const messageDeleteMany = jest.fn();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversationMember: {
            findUnique: memberFindUnique,
            update: memberUpdate,
          },
          message: {
            findFirst: messageFindFirst,
            deleteMany: messageDeleteMany,
          },
        }),
    );

    await expect(
      repository.clearForMember(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toEqual({
      status: 'cleared',
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      changed: true,
      clearedAt: latestMessageAt,
      clearedThroughMessageId: MESSAGE_ID,
      occurredAt: NOW,
    });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: {
        conversationId_userId: {
          conversationId: CONVERSATION_ID,
          userId: USER_ID,
        },
      },
      data: {
        clearedAt: latestMessageAt,
        clearedThroughMessageId: MESSAGE_ID,
        unreadCount: 0,
      },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(messageDeleteMany).not.toHaveBeenCalled();
  });

  it('conceals a clear request when the caller is not a member', async () => {
    const { repository, transaction } = createRepository();
    const memberFindUnique = jest.fn().mockResolvedValue(null);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({ conversationMember: { findUnique: memberFindUnique } }),
    );

    await expect(
      repository.clearForMember(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toEqual({ status: 'conversation-not-found' });
  });

  it('conceals a membership removed while clear is committing', async () => {
    const { repository, transaction } = createRepository();
    const memberFindUnique = jest.fn().mockResolvedValue({
      clearedAt: null,
      clearedThroughMessageId: null,
      unreadCount: 1,
    });
    const memberUpdate = jest
      .fn()
      .mockRejectedValue(knownRequestError('P2025'));
    const messageFindFirst = jest.fn().mockResolvedValue({
      id: MESSAGE_ID,
      createdAt: NOW,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversationMember: {
            findUnique: memberFindUnique,
            update: memberUpdate,
          },
          message: { findFirst: messageFindFirst },
        }),
    );

    await expect(
      repository.clearForMember(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toEqual({ status: 'conversation-not-found' });
  });

  it('retries a clear after a serializable write conflict', async () => {
    const { repository, transaction } = createRepository();
    const memberFindUnique = jest.fn().mockResolvedValue({
      clearedAt: NOW,
      clearedThroughMessageId: MESSAGE_ID,
      unreadCount: 0,
    });
    const messageFindFirst = jest.fn().mockResolvedValue({
      id: MESSAGE_ID,
      createdAt: NOW,
    });
    transaction
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockImplementationOnce(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation({
            conversationMember: { findUnique: memberFindUnique },
            message: { findFirst: messageFindFirst },
          }),
      );

    await expect(
      repository.clearForMember(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toMatchObject({ status: 'cleared', changed: false });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
