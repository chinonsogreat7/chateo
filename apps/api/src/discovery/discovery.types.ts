export interface PublicDiscoveryUserRecord {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}

export interface ContactMatchRecord extends PublicDiscoveryUserRecord {
  phoneNumber: string;
}

export interface DiscoveryCursorBoundary {
  createdAt: Date;
  id: string;
}

export interface MatchContactsRepositoryInput {
  currentUserId: string;
  phoneNumbers: readonly string[];
}

export interface SearchUsersRepositoryInput {
  currentUserId: string;
  normalizedQuery: string;
  databaseQuery: string;
  take: number;
  after?: DiscoveryCursorBoundary;
}
