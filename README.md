# ChatMe

ChatMe is a WhatsApp-style mobile chat project. This repository is being built as a monorepo so the backend, future mobile client, and shared contracts can evolve together.

The current vertical slice is the authentication backend, guided by the [ChatMe Figma design](https://www.figma.com/design/TMSAXEwYtU57KMvtaY1ckh/ChatMe-App?node-id=0-1) and the project rubric in this workspace.

## Current status

- Phone-number authentication using E.164 numbers
- OTP request, resend cooldown, verification, expiry, and cumulative attempt lockout
- New-user creation only after phone ownership is verified
- Profile name setup and optional avatar URL
- Privacy-safe matching of phone numbers already present in a user's contacts
- Registered-user search by display name without exposing phone numbers
- Idempotent direct-conversation creation with membership-protected list/detail APIs
- Short-lived JWT access tokens
- Opaque, hashed, rotating refresh tokens with replay-family revocation
- Persistent sessions and immediate server-side logout
- PostgreSQL schema and committed Prisma migration
- Swagger/OpenAPI documentation in non-production environments
- Development console OTP delivery and production Twilio SMS delivery

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

Replace the two placeholder secrets in `apps/api/.env`. Generate independent values with:

```bash
openssl rand -base64 48
```

Start the API:

```bash
npm run dev:api
```

The API is available at `http://localhost:3000/v1`; interactive documentation is at `http://localhost:3000/v1/docs` outside production.

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
