import { ApiException } from '../common/errors/api.exception';
import { PhoneNumberService } from '../auth/providers/phone-number.service';
import { DiscoveryRepository } from './discovery.repository';
import { DiscoveryService } from './discovery.service';
import type {
  ContactMatchRecord,
  MatchContactsRepositoryInput,
  PublicDiscoveryUserRecord,
  SearchUsersRepositoryInput,
} from './discovery.types';

class TestDiscoveryRepository extends DiscoveryRepository {
  matchResults: ContactMatchRecord[] = [];
  searchResults: PublicDiscoveryUserRecord[] = [];
  matchInput?: MatchContactsRepositoryInput;
  searchInput?: SearchUsersRepositoryInput;

  override async matchContacts(
    input: MatchContactsRepositoryInput,
  ): Promise<ContactMatchRecord[]> {
    this.matchInput = input;
    return this.matchResults;
  }

  override async searchUsers(
    input: SearchUsersRepositoryInput,
  ): Promise<PublicDiscoveryUserRecord[]> {
    this.searchInput = input;
    return this.searchResults;
  }
}

function apiErrorResponse(error: unknown): unknown {
  return error instanceof ApiException ? error.getResponse() : error;
}

async function expectApiErrorResponse(
  promise: Promise<unknown>,
  response: unknown,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('Expected the operation to reject, but it resolved.');
    },
    (reason: unknown) => reason,
  );
  expect(apiErrorResponse(error)).toEqual(response);
}

const currentUserId = 'b5a64434-dbc8-4c61-a535-6c93e49ca6bc';
const ada: PublicDiscoveryUserRecord = {
  id: '697dd7df-9d66-4b97-bf00-a56beae01937',
  displayName: 'Ada Okafor',
  avatarUrl: 'https://example.com/ada.jpg',
  createdAt: new Date('2026-08-12T10:00:00.000Z'),
};
const amaka: PublicDiscoveryUserRecord = {
  id: '4eb7262d-7a31-45a3-a03a-2be8a1126984',
  displayName: 'Amaka Obi',
  avatarUrl: null,
  createdAt: new Date('2026-08-12T09:00:00.000Z'),
};
const anya: PublicDiscoveryUserRecord = {
  id: '58a1007f-2752-4e44-bf1c-51b8a5107b83',
  displayName: 'Anya Eze',
  avatarUrl: null,
  createdAt: new Date('2026-08-12T08:00:00.000Z'),
};

describe('DiscoveryService', () => {
  let repository: TestDiscoveryRepository;
  let service: DiscoveryService;

  beforeEach(() => {
    repository = new TestDiscoveryRepository();
    service = new DiscoveryService(repository, new PhoneNumberService());
  });

  it('normalizes, deduplicates, and returns contact matches in caller order', async () => {
    repository.matchResults = [
      {
        ...amaka,
        phoneNumber: '+2348098765432',
      },
      {
        ...ada,
        phoneNumber: '+2348012345678',
      },
    ];

    await expect(
      service.matchContacts(currentUserId, [
        ' +2348012345678 ',
        '+2348098765432',
        '+234 801 234 5678',
      ]),
    ).resolves.toEqual({
      matches: [
        {
          matchedPhoneNumber: '+2348012345678',
          user: {
            id: ada.id,
            displayName: ada.displayName,
            avatarUrl: ada.avatarUrl,
          },
        },
        {
          matchedPhoneNumber: '+2348098765432',
          user: {
            id: amaka.id,
            displayName: amaka.displayName,
            avatarUrl: amaka.avatarUrl,
          },
        },
      ],
    });

    expect(repository.matchInput).toEqual({
      currentUserId,
      phoneNumbers: ['+2348012345678', '+2348098765432'],
    });
  });

  it('rejects the whole batch with every invalid index and makes no query', async () => {
    const promise = service.matchContacts(currentUserId, [
      '+2348012345678',
      '08012345678',
      '+234 809 876 5432',
      1234,
    ]);

    await expectApiErrorResponse(promise, {
      code: 'CONTACTS_INVALID_PHONE_NUMBER',
      message: 'One or more phone numbers are not valid E.164 numbers.',
      details: { invalidIndices: [1, 3] },
    });
    expect(repository.matchInput).toBeUndefined();
  });

  it('returns an opaque next cursor and uses it for the next keyset page', async () => {
    repository.searchResults = [ada, amaka, anya];
    const firstPage = await service.searchUsers(currentUserId, {
      q: '  ADA   OKAFOR ',
      limit: 2,
    });

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(repository.searchInput).toEqual({
      currentUserId,
      normalizedQuery: 'ada okafor',
      databaseQuery: 'ada okafor',
      take: 3,
    });

    repository.searchResults = [];
    await service.searchUsers(currentUserId, {
      q: 'ada okafor',
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(repository.searchInput).toEqual({
      currentUserId,
      normalizedQuery: 'ada okafor',
      databaseQuery: 'ada okafor',
      take: 3,
      after: { createdAt: amaka.createdAt, id: amaka.id },
    });
  });

  it('escapes SQL LIKE metacharacters without changing cursor binding', async () => {
    await service.searchUsers(currentUserId, {
      q: 'A_%\\B',
      limit: 20,
    });

    expect(repository.searchInput).toEqual({
      currentUserId,
      normalizedQuery: 'a_%\\b',
      databaseQuery: 'a\\_\\%\\\\b',
      take: 21,
    });
  });

  it.each(['not-a-cursor!', undefined])(
    'uses one stable error code for an invalid or query-mismatched cursor',
    async (invalidCursor) => {
      let cursor = invalidCursor;
      if (cursor === undefined) {
        repository.searchResults = [ada, amaka];
        const firstPage = await service.searchUsers(currentUserId, {
          q: 'ada',
          limit: 1,
        });
        cursor = firstPage.nextCursor ?? undefined;
      }

      const promise = service.searchUsers(currentUserId, {
        q: invalidCursor === undefined ? 'amaka' : 'ada',
        limit: 1,
        cursor,
      });
      await expectApiErrorResponse(promise, {
        code: 'DISCOVERY_INVALID_CURSOR',
        message: 'The pagination cursor is invalid for this search.',
      });
    },
  );
});
