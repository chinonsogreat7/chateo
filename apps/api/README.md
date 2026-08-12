# ChatMe API

The API is a modular NestJS service backed by PostgreSQL through Prisma. Authentication is phone-first because the approved Figma journey is:

```text
Phone number → Verification code → Name → Optional photo → App
```

## Figma mapping

| Figma screen      | Backend behavior                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| Add Phone Number  | Normalize and validate an E.164 number, then create an OTP challenge.                                |
| Verification Code | Verify a one-time code, enforce expiry and cumulative attempts, and create a persistent session.     |
| Resend Code       | Enforce the server cooldown, invalidate the prior challenge, and preserve the failed-attempt budget. |
| Name              | `PATCH /v1/me` sets `displayName` and completes the required profile step.                           |
| Upload a Photo    | `avatarUrl` is optional; binary media upload will be added with the media service.                   |

The Figma file currently shows four code boxes. Development/course mode defaults to four digits and the OTP response includes `codeLength` so the client can render dynamically. Production configuration requires at least six digits.

## Endpoints

| Method  | Path                                         | Auth   | Purpose                                      |
| ------- | -------------------------------------------- | ------ | -------------------------------------------- |
| `GET`   | `/v1/health`                                 | Public | Liveness check                               |
| `POST`  | `/v1/auth/otp/request`                       | Public | Request a verification code                  |
| `POST`  | `/v1/auth/otp/resend`                        | Public | Resend after the cooldown                    |
| `POST`  | `/v1/auth/otp/verify`                        | Public | Verify and receive a token pair              |
| `POST`  | `/v1/auth/refresh`                           | Public | Rotate a refresh token                       |
| `POST`  | `/v1/auth/logout`                            | Public | Revoke a refresh session; always idempotent  |
| `GET`   | `/v1/me`                                     | Bearer | Read the signed-in profile                   |
| `PATCH` | `/v1/me`                                     | Bearer | Set the name and optional avatar URL         |
| `POST`  | `/v1/contacts/match`                         | Bearer | Match phone numbers already known to caller  |
| `GET`   | `/v1/users/search`                           | Bearer | Search completed profiles by display name    |
| `POST`  | `/v1/conversations/direct`                   | Bearer | Create or return a direct conversation       |
| `GET`   | `/v1/conversations`                          | Bearer | List the signed-in user's conversations      |
| `GET`   | `/v1/conversations/:conversationId`          | Bearer | Open a conversation as a member              |
| `POST`  | `/v1/conversations/:conversationId/messages` | Bearer | Persist or replay an idempotent text message |
| `GET`   | `/v1/conversations/:conversationId/messages` | Bearer | Read newest-first message history            |
| `POST`  | `/v1/conversations/:conversationId/read`     | Bearer | Mark currently persisted messages as read    |

Authentication, profile, discovery, conversation, and message responses include
`Cache-Control: no-store`.

### Request an OTP

```http
POST /v1/auth/otp/request
Content-Type: application/json

{
  "phoneNumber": "+2348012345678"
}
```

```json
{
  "challengeId": "8f61f783-c84e-4209-b740-4205748df93e",
  "phoneNumberMasked": "+234********78",
  "expiresInSeconds": 300,
  "resendInSeconds": 24,
  "codeLength": 4
}
```

### Verify the OTP

```http
POST /v1/auth/otp/verify
Content-Type: application/json

{
  "challengeId": "8f61f783-c84e-4209-b740-4205748df93e",
  "code": "2468",
  "device": {
    "name": "Great's iPhone",
    "platform": "ios"
  }
}
```

A successful response contains an access token, a one-use refresh token, their TTLs, and the user. `profileComplete` is false until a valid display name is saved.

The mobile app must place the access token in `Authorization: Bearer <token>` and store the refresh token in platform secure storage, never AsyncStorage or application logs.

### Complete the profile

```http
PATCH /v1/me
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "displayName": "Great Ichoku"
}
```

The avatar is optional. The current `avatarUrl` field is a bridge for the upcoming media service; clients should not invent URLs.

## User discovery and contacts

There is no public phone-number directory. The mobile app may request contact permission, normalize numbers to E.164, and send only numbers already known to that user:

```http
POST /v1/contacts/match
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "phoneNumbers": [
    "+12025550102",
    "+12025550103"
  ]
}
```

The API performs exact matches, excludes the signed-in user, does not store the address-book payload, and returns matches in caller order:

```json
{
  "matches": [
    {
      "matchedPhoneNumber": "+12025550102",
      "user": {
        "id": "00000000-0000-4000-8000-000000000102",
        "displayName": "Tunde Bello",
        "avatarUrl": null
      }
    }
  ]
}
```

`matchedPhoneNumber` is a canonical version of a number the caller submitted. The nested public user never contains a phone number. Batches contain 1-100 numbers; if any value is invalid, the whole request is rejected with `CONTACTS_INVALID_PHONE_NUMBER` and invalid array indices only.

The API accepts common international formatting such as spaces or dashes, but every value must start with `+`. It normalizes valid values to canonical E.164 before deduplication and matching.

Display-name search is separate and never searches phone numbers:

```http
GET /v1/users/search?q=tunde&limit=20
Authorization: Bearer <access-token>
```

The response uses an opaque `nextCursor`; pass it unchanged with the same search term to fetch the next page. Searches require at least three characters, exclude the caller and incomplete profiles, and do not return a total directory size.

## Direct conversations

Create a direct conversation with the immutable user ID returned by discovery:

```http
POST /v1/conversations/direct
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "participantId": "00000000-0000-4000-8000-000000000102"
}
```

The operation is idempotent: repeated requests, including a reversed request from the other participant, return the same conversation. Database uniqueness and serializable retries prevent concurrent duplicates.

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "direct",
  "otherParticipant": {
    "id": "00000000-0000-4000-8000-000000000102",
    "displayName": "Tunde Bello",
    "avatarUrl": null
  },
  "latestMessage": null,
  "unreadCount": 0,
  "lastActivityAt": "2026-08-12T12:30:00.000Z",
  "createdAt": "2026-08-12T12:30:00.000Z",
  "updatedAt": "2026-08-12T12:30:00.000Z"
}
```

`GET /v1/conversations` uses opaque cursor pagination.
`GET /v1/conversations/:conversationId` returns `CONVERSATION_NOT_FOUND` for
both a missing conversation and a non-member, avoiding existence disclosure.
After messages are sent, `latestMessage` contains a safe 120-code-point preview
and `unreadCount` is specific to the signed-in user.

## Text messages

Generate one UUID on the device for each composed message and keep it when
retrying the request:

```http
POST /v1/conversations/550e8400-e29b-41d4-a716-446655440000/messages
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "clientMessageId": "7d444840-9dc0-41d1-b245-5ffdce74fad2",
  "text": "Hello! Are you free to chat?"
}
```

The endpoint always returns `200 OK` for a new message or an identical retry.
Reusing the same `clientMessageId` with different text or a different
conversation returns `409 MESSAGE_IDEMPOTENCY_CONFLICT`. Text is trimmed and
must contain 1-4000 characters after trimming.

```json
{
  "id": "9b2a35a6-6542-48b1-8232-0ac6476db74b",
  "conversationId": "550e8400-e29b-41d4-a716-446655440000",
  "clientMessageId": "7d444840-9dc0-41d1-b245-5ffdce74fad2",
  "senderId": "00000000-0000-4000-8000-000000000101",
  "kind": "text",
  "text": "Hello! Are you free to chat?",
  "createdAt": "2026-08-12T16:00:00.000Z"
}
```

Fetch history with:

```http
GET /v1/conversations/:conversationId/messages?limit=50&cursor=<opaque>
Authorization: Bearer <access-token>
```

Items are ordered newest first. Pass `pageInfo.nextCursor` unchanged on the
same conversation route to load older messages; clients must not inspect or
construct it.

Once the user has rendered all currently returned messages, mark the
conversation read:

```http
POST /v1/conversations/:conversationId/read
Authorization: Bearer <access-token>
```

This atomically resets that member's unread count and records a read boundary
that never moves backwards. Sending, unread increments, chat-list activity, and
message persistence happen in one database transaction.

## Realtime delivery

Socket.IO uses the API origin with the `/chat` namespace, not the REST `/v1`
prefix. Authenticate with the current access token in the handshake:

```ts
import { io } from 'socket.io-client';

const socket = io(`${apiOrigin}/chat`, {
  auth: { token: accessToken },
});

socket.on('message.created', (message) => {
  // Same public shape returned by POST .../messages.
});
```

An `Authorization: Bearer <access-token>` handshake header is also supported.
Invalid, expired, or revoked sessions fail with a `connect_error` whose data
contains `code: "AUTH_ACCESS_TOKEN_INVALID"`. A connected socket is closed when
its access token expires; after refreshing, reconnect it with the new access
token.

There is intentionally no client-to-server socket event for sending messages.
REST is the authoritative write path, while `message.created` is a low-latency
notification delivered to all active devices belonging to both participants.
On initial connection or reconnection, always reconcile through the REST
history endpoint because socket delivery is best-effort. Do not treat socket
arrival order as message order; render the persisted `createdAt`/`id` order
returned by history and deduplicate by the server message `id`.

The current Socket.IO adapter is suitable for the single Render instance used
by the classroom project. Before horizontally scaling, add a shared Socket.IO
adapter (for example Redis) so user rooms and events span every API instance.

## Error shape

Errors use a stable machine-readable code:

```json
{
  "statusCode": 401,
  "code": "AUTH_INVALID_OTP",
  "message": "The verification code is invalid.",
  "details": {
    "attemptsRemaining": 4
  },
  "path": "/v1/auth/otp/verify",
  "timestamp": "2026-08-09T00:00:00.000Z"
}
```

Important auth codes include `AUTH_INVALID_PHONE_NUMBER`, `AUTH_OTP_COOLDOWN`, `AUTH_INVALID_OTP`, `AUTH_OTP_EXPIRED`, `AUTH_OTP_ATTEMPTS_EXCEEDED`, `AUTH_REFRESH_TOKEN_INVALID`, `AUTH_REFRESH_TOKEN_REUSED`, and `AUTH_ACCESS_TOKEN_INVALID`.

Discovery, conversation, and message codes include
`CONTACTS_INVALID_PHONE_NUMBER`, `DISCOVERY_INVALID_CURSOR`,
`CONVERSATION_SELF_NOT_ALLOWED`, `CONVERSATION_CURSOR_INVALID`,
`CONVERSATION_NOT_FOUND`, `USER_NOT_FOUND`, `MESSAGE_CURSOR_INVALID`, and
`MESSAGE_IDEMPOTENCY_CONFLICT`.

## Security behavior

- Phone numbers are normalized and stored in E.164 form.
- OTP values are stored only as HMAC-SHA-256 digests bound to the challenge and phone number.
- OTPs are single-use, expire after five minutes by default, and have a 24-second resend cooldown.
- Failed attempts are authoritative in PostgreSQL and do not reset when a code is resent.
- Local fixed OTPs and the console sender are forbidden in production; the Twilio adapter uses API-key credentials.
- Access tokens contain user/session identifiers and profile state, not phone-number PII.
- Refresh tokens contain 256 bits of random secret material and are stored only as SHA-256 digests.
- Every refresh rotates the session credential. Reusing a rotated token revokes the active token family.
- The access-token guard checks session state, so logout takes effect immediately rather than waiting for JWT expiry.
- Database transactions use serializable isolation with bounded conflict retries for OTP replacement/consumption, failed-attempt updates, and refresh rotation.
- Public OTP and refresh endpoints have IP throttles. Distributed deployments should replace the default in-memory throttle store with Redis.
- Contact matching is exact-only, accepts at most 100 caller-supplied numbers, is never persisted, and returns no unmatched numbers.
- Discovery and conversation responses use a public user shape that omits phone numbers.
- Direct-conversation participant pairs are stored in canonical UUID order under a database unique constraint.
- Message send retries are deduplicated by `(senderId, clientMessageId)` before unread counters change.
- Socket handshakes validate both the JWT and its server-side session; private events are revalidated before delivery.

## Environment

Copy `.env.example` to `.env` and configure:

| Variable                            | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `NODE_ENV`                          | `development`, `test`, or `production`                       |
| `DATABASE_URL`                      | PostgreSQL connection string                                 |
| `JWT_ACCESS_SECRET`                 | Access-token signing secret, at least 32 characters          |
| `OTP_HASH_SECRET`                   | Independent OTP HMAC secret, at least 32 characters          |
| `OTP_PROVIDER`                      | `console` for development/test; `twilio` for production      |
| `TWILIO_ACCOUNT_SID`                | Twilio account that owns the sender                          |
| `TWILIO_API_KEY`                    | Twilio API key used for HTTP Basic authentication            |
| `TWILIO_API_SECRET`                 | Secret paired with the Twilio API key                        |
| `TWILIO_FROM_NUMBER`                | Twilio sender in E.164 form                                  |
| `AUTH_FIXED_OTP`                    | Optional local/test code; must be empty in production        |
| `AUTH_OTP_LENGTH`                   | 4–8 digits; production requires at least 6                   |
| `AUTH_OTP_TTL_SECONDS`              | Code lifetime                                                |
| `AUTH_OTP_RESEND_SECONDS`           | Server-side resend cooldown                                  |
| `AUTH_OTP_MAX_ATTEMPTS`             | Cumulative failure limit                                     |
| `AUTH_OTP_LOCK_SECONDS`             | Lock duration after the failure limit                        |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`     | Access-token lifetime                                        |
| `AUTH_REFRESH_TOKEN_TTL_SECONDS`    | Rotating session lifetime                                    |
| `API_DOCS_ENABLED`                  | Expose Swagger UI and OpenAPI JSON; defaults to `true`       |
| `REALTIME_MAX_CONNECTIONS_PER_USER` | Per-instance authenticated socket cap; defaults to `5`       |
| `CORS_ORIGINS`                      | Comma-separated browser origins for production               |
| `TRUST_PROXY`                       | Express trust-proxy setting used for accurate throttling IPs |
| `ALLOW_DEMO_SEED`                   | Must equal `true` to run the manual classroom seed command   |

## Database

Apply committed migrations in deployed environments:

```bash
npm run prisma:deploy --workspace @chateo/api
```

Create a migration only during schema development:

```bash
npm run prisma:migrate --workspace @chateo/api -- --name describe_change
```

Do not use `prisma db push` for production schema changes.

For the existing Render web service, keep migrations in the build command so a
new release never starts against an older schema:

```text
Build command: npm ci && npm run build && npm run prisma:deploy --workspace @chateo/api
Start command: npm run start:api
Health check: /v1/health
Node version: 22
```

The new text-message release requires the committed
`20260812160000_add_text_messages` migration before it accepts traffic.

Run the real-PostgreSQL integration suite against a dedicated database whose
name ends in `_integration` (or a dedicated schema beginning with
`chateo_integration`). Apply migrations first:

```bash
DATABASE_URL='postgresql://.../chateo_integration?schema=public' npm run prisma:deploy --workspace @chateo/api
DATABASE_URL_INTEGRATION='postgresql://.../chateo_integration?schema=public' npm run test:integration
```

Use a unique integration database or schema per CI job. The suite refuses a
normal database name to reduce the risk of deleting non-test fixtures.

## Optional classroom accounts

After migrations, an instructor may seed three fictional accounts manually:

```bash
ALLOW_DEMO_SEED=true npm run prisma:seed
```

| Display name | Fictional phone number |
| ------------ | ---------------------- |
| Ada Okafor   | `+12025550101`         |
| Tunde Bello  | `+12025550102`         |
| Maya Chen    | `+12025550103`         |

The seed uses upserts and completes the documented demo profiles without replacing an existing user ID. It does not create sessions, tokens, conversations, or a test OTP. Users still authenticate through the configured instructor OTP flow. The command is blocked when `NODE_ENV=production`; do not run it automatically during deployment.

## SMS provider boundary

`OtpDeliveryProvider` isolates delivery from authentication logic. The console implementation is intentionally rejected when `NODE_ENV=production`; set `OTP_PROVIDER=twilio` and supply the four Twilio variables above for live SMS. Provider failures are translated at the service boundary, and response payloads are never logged.
