# ChatMe

ChatMe is a WhatsApp-style mobile chat project. This repository is being built as a monorepo so the backend, future mobile client, and shared contracts can evolve together.

The current backend supports the student mobile team from sign-in through live
direct and group text chat. It is guided by the
[ChatMe Figma design](https://www.figma.com/design/TMSAXEwYtU57KMvtaY1ckh/ChatMe-App?node-id=0-1)
and the project rubric in this workspace.

## Current status

- Phone-number authentication using E.164 numbers
- OTP request, resend cooldown, verification, expiry, and cumulative attempt lockout
- New-user creation only after phone ownership is verified
- Profile name setup and optional avatar URL
- Privacy-safe matching of phone numbers already present in a user's contacts
- Registered-user search by display name without exposing phone numbers
- Idempotent direct-conversation creation with membership-protected list/detail APIs
- Per-user archive, mute, and pin settings with pinned-first conversation lists, plus idempotent user blocking
- Complete group lifecycle APIs for metadata, members, admins, ownership, leaving, and deletion
- Persistent, idempotent text-message sending and cursor-paginated history
- Per-user unread counts, durable delivery/read receipts, and latest-message chat-list previews
- Authenticated Socket.IO conversation, message, receipt, presence, and typing events on the `/chat` namespace
- Short-lived JWT access tokens
- Opaque, hashed, rotating refresh tokens with replay-family revocation
- Persistent sessions and immediate server-side logout
- PostgreSQL schema and versioned Prisma migrations
- Swagger/OpenAPI documentation in non-production environments
- Development console OTP delivery and production Twilio SMS delivery

Mute is persisted as a per-user preference, but push notification delivery and
mute-based notification filtering are not implemented yet.

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

Replace the two placeholder secrets in `apps/api/.env`. Generate independent values with:

```bash
openssl rand -base64 48
```

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

See [apps/api/README.md](apps/api/README.md) for the endpoint contract, environment settings, security behavior, and Figma-to-API mapping.
