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

| Method  | Path                   | Auth   | Purpose                                     |
| ------- | ---------------------- | ------ | ------------------------------------------- |
| `GET`   | `/v1/health`           | Public | Liveness check                              |
| `POST`  | `/v1/auth/otp/request` | Public | Request a verification code                 |
| `POST`  | `/v1/auth/otp/resend`  | Public | Resend after the cooldown                   |
| `POST`  | `/v1/auth/otp/verify`  | Public | Verify and receive a token pair             |
| `POST`  | `/v1/auth/refresh`     | Public | Rotate a refresh token                      |
| `POST`  | `/v1/auth/logout`      | Public | Revoke a refresh session; always idempotent |
| `GET`   | `/v1/me`               | Bearer | Read the signed-in profile                  |
| `PATCH` | `/v1/me`               | Bearer | Set the name and optional avatar URL        |

All authentication and profile responses include `Cache-Control: no-store`.

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

## Environment

Copy `.env.example` to `.env` and configure:

| Variable                         | Purpose                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                   | PostgreSQL connection string                                 |
| `JWT_ACCESS_SECRET`              | Access-token signing secret, at least 32 characters          |
| `OTP_HASH_SECRET`                | Independent OTP HMAC secret, at least 32 characters          |
| `OTP_PROVIDER`                   | `console` for development/test; `twilio` for production      |
| `TWILIO_ACCOUNT_SID`             | Twilio account that owns the sender                          |
| `TWILIO_API_KEY`                 | Twilio API key used for HTTP Basic authentication            |
| `TWILIO_API_SECRET`              | Secret paired with the Twilio API key                        |
| `TWILIO_FROM_NUMBER`             | Twilio sender in E.164 form                                  |
| `AUTH_FIXED_OTP`                 | Optional local/test code; must be empty in production        |
| `AUTH_OTP_LENGTH`                | 4–8 digits; production requires at least 6                   |
| `AUTH_OTP_TTL_SECONDS`           | Code lifetime                                                |
| `AUTH_OTP_RESEND_SECONDS`        | Server-side resend cooldown                                  |
| `AUTH_OTP_MAX_ATTEMPTS`          | Cumulative failure limit                                     |
| `AUTH_OTP_LOCK_SECONDS`          | Lock duration after the failure limit                        |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`  | Access-token lifetime                                        |
| `AUTH_REFRESH_TOKEN_TTL_SECONDS` | Rotating session lifetime                                    |
| `CORS_ORIGINS`                   | Comma-separated browser origins for production               |
| `TRUST_PROXY`                    | Express trust-proxy setting used for accurate throttling IPs |

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

## SMS provider boundary

`OtpDeliveryProvider` isolates delivery from authentication logic. The console implementation is intentionally rejected when `NODE_ENV=production`; set `OTP_PROVIDER=twilio` and supply the four Twilio variables above for live SMS. Provider failures are translated at the service boundary, and response payloads are never logged.
