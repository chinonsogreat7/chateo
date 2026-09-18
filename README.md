# ChatMe

ChatMe is a WhatsApp-style mobile chat project. This repository is being built as a monorepo so the backend, future mobile client, and shared contracts can evolve together.

The current backend supports the student mobile team from sign-in through live
direct and group text, image, audio, video, and document chat. It is guided by the
[ChatMe Figma design](https://www.figma.com/design/TMSAXEwYtU57KMvtaY1ckh/ChatMe-App?node-id=0-1)
and the project rubric in this workspace.

## Current status

- Phone-number authentication using E.164 numbers
- OTP request, resend cooldown, verification, expiry, and cumulative attempt lockout
- New-user creation only after phone ownership is verified
- Profile name setup and verified Cloudinary-backed image avatars
- Privacy-safe matching of phone numbers already present in a user's contacts
- Registered-user search by display name without exposing phone numbers
- Idempotent direct-conversation creation with membership-protected list/detail APIs
- Per-user archive, timed mute, pin, favorite, and non-destructive clear-history controls, plus idempotent user blocking
- Dedicated archive, favorite-list, pin/unpin, and paginated archived-chat APIs for both direct chats and groups
- Complete group lifecycle APIs for metadata, members, admins, ownership, leaving, and deletion
- Verified group photos with owner/admin-only assignment and removal, plus realtime metadata updates
- Persistent, idempotent text, image, audio, video, and document messages with cursor-paginated history
- Replies, reactions, sender-only editing/deletion, message search, and versioned socket updates
- Idempotent signed uploads for avatars and all supported attachment kinds, including bounded document-content verification
- Per-user unread counts, durable delivery/read receipts, and latest-message chat-list previews
- Authenticated Socket.IO conversation, message, receipt, presence, and typing events on the `/chat` namespace
- Short-lived JWT access tokens
- Opaque, hashed, rotating refresh tokens with replay-family revocation
- Persistent sessions and immediate server-side logout
- PostgreSQL schema and versioned Prisma migrations
- Swagger/OpenAPI documentation in non-production environments
- Development console OTP delivery and production Twilio SMS delivery

Mute windows are persisted per user with exact 8-hour, 24-hour, 7-day, or
indefinite durations. Optional Expo offline push notifications respect these
windows; muting never suppresses persisted messages or Socket.IO events.
Unused completed uploads and replaced avatars can be cleaned up after a
configurable grace period. Both workers are opt-in; see
[push and cleanup setup](apps/api/BACKGROUND_WORKERS.md).

For the mobile integration and classroom walkthrough, see the
[end-to-end media upload guide](apps/api/MEDIA_UPLOADS.md): authorization,
Cloudinary transfer, verification, chat/avatar assignment, and retry handling.

Archive changes are idempotent and affect only the signed-in member. Dedicated
archive routes coexist with the legacy conversation-list `archived=true` query
and conversation-settings `PATCH` route so existing clients keep working.

Direct chats support `DELETE /v1/conversations/:conversationId/for-me`: hide the
chat and existing history only for the caller, keeping the peer's copy intact.
A new message restores the chat without restoring cleared history. See the
[API deletion contract](apps/api/README.md#delete-a-one-to-one-chat-for-me).
Favorites have their own paginated active/archived list, and pin/unpin now have
explicit idempotent action routes while remaining compatible with the settings
route.

The SMS integration uses a console adapter in development and a Twilio API-key adapter in production.

## Workspace

```text
apps/api/          NestJS + Prisma + PostgreSQL API
packages/          Reserved for shared contracts
audit/             UI reference captures
```

## Quick start

Prerequisites:

- Node.js 20.9 or newer; Node.js 22 LTS is recommended for deployment.
- PostgreSQL, or Docker with Compose.

Install dependencies from the repository root:

```bash
node scripts/verify-tooling.mjs
npm install
```

Configure and start the database:

```bash
cp apps/api/.env.example apps/api/.env
docker compose -f apps/api/compose.yaml up -d
npm run prisma:deploy --workspace @chateo/api
```

The chat-management migrations upgrade any legacy group that has members by
choosing its earliest member as owner and creator and assigning a stable
placeholder name. It refuses to migrate an orphan group with no memberships so
the data can be repaired explicitly before retrying. A follow-up ownership
constraint refuses inconsistent historical groups and prevents multiple owners.
The conversation-controls migration adds per-member mute expiry, favorite, and
clear-history boundaries; clearing history never deletes shared message rows.
The favorites-list migration adds the member lookup index used by the dedicated
favorites feed.
The media-assets migration adds the server-owned Cloudinary upload lifecycle
and the verified profile-avatar relationship; binary files remain outside
PostgreSQL. Documents are downloaded transiently by the API for bounded validation.
The message-image migration adds ordered, single-use media references to
messages; the same message endpoint works for direct chats and groups.
The audio-message migration adds the `AUDIO` message kind while reusing those
single-use media references for one verified recording per message.
The group-avatar migration adds an indexed media reference to conversations.
Existing avatar URLs remain readable, but new group-photo assignments require
an owned, ready `group_avatar` media ID. Deploy this migration before running
the updated API (`npm run prisma:deploy --workspace @chateo/api`).
The advanced-message migration adds replies, revisions, tombstones, reactions,
send fingerprints, and video/document message kinds. Deployment and client
contracts are covered in [the advanced messaging guide](apps/api/MESSAGING.md).

Replace the two placeholder secrets in `apps/api/.env`. Generate independent values with:

```bash
openssl rand -base64 48
```

Media uploads are disabled by default. To enable Cloudinary, set
`MEDIA_UPLOADS_ENABLED=true` and configure the cloud name, API key, API secret,
and signed image upload preset documented in `apps/api/.env.example`. That
image preset is shared by profile avatars, group photos, and chat images and must enforce a
5 MiB maximum. Before authorizing audio recordings, also configure the separate
signed audio preset with the documented formats and 20 MiB maximum.
Video and documents each need a separate signed preset (50 MiB and 25 MiB,
respectively); see [setup and validation limits](apps/api/MESSAGING.md#deployment).

Start the API:

```bash
npm run dev:api
```

The REST API is available at `http://localhost:3000/v1`; the Socket.IO
namespace is `http://localhost:3000/chat`. Interactive documentation is at
`http://localhost:3000/v1/docs` when `API_DOCS_ENABLED=true` (the default).

Optionally seed three fictional classroom accounts after applying migrations:

```bash
ALLOW_DEMO_SEED=true npm run prisma:seed
```

The seed is manual and idempotent. It never creates sessions or authentication tokens.

## Verification

```bash
npm run security:check
npm run test:security
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm audit --omit=dev
```

The real-PostgreSQL concurrency suite is opt-in because it requires an isolated,
migrated database. See `apps/api/README.md` for the `test:integration` setup.

Executable tooling configs have a reviewed integrity baseline. See [SECURITY.md](SECURITY.md)
before approving a changed baseline or running an older/untrusted checkout.

See [apps/api/README.md](apps/api/README.md) for the endpoint contract, environment settings, security behavior, and Figma-to-API mapping.
