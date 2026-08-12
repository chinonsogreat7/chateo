import type {
  ContactMatchRecord,
  MatchContactsRepositoryInput,
  PublicDiscoveryUserRecord,
  SearchUsersRepositoryInput,
} from './discovery.types';

export abstract class DiscoveryRepository {
  abstract matchContacts(
    input: MatchContactsRepositoryInput,
  ): Promise<ContactMatchRecord[]>;

  abstract searchUsers(
    input: SearchUsersRepositoryInput,
  ): Promise<PublicDiscoveryUserRecord[]>;
}
