# Media uploads: end-to-end integration guide

For the Chateo mobile team and classroom exercises. Checked against the API
implementation on 16 September 2026. Examples use fictional IDs and placeholder
credentials: replace them with values from your own requests.

**The app uploads the file directly to Cloudinary. Our API authorizes the upload,
verifies it, and attaches the verified media to a message or avatar.** Uploading a
file does not automatically send a message or change a profile picture.

## Contents

1. [The flow at a glance](#1-the-flow-at-a-glance)
2. [Prerequisites and IDs](#2-prerequisites-and-ids)
3. [Supported files and purposes](#3-supported-files-and-purposes)
4. [Walkthrough: send a chat image](#4-walkthrough-send-a-chat-image)
5. [Profile and group pictures](#5-profile-and-group-pictures)
6. [Client-side reference example](#6-client-side-reference-example)
7. [Swagger and Postman exercise](#7-swagger-and-postman-exercise)
8. [Retries, expiry and cancellation](#8-retries-expiry-and-cancellation)
9. [Errors and troubleshooting](#9-errors-and-troubleshooting)
10. [Server configuration](#10-server-configuration)
11. [Security and cleanup](#11-security-and-cleanup)
12. [End-to-end acceptance checklist](#12-end-to-end-acceptance-checklist)

## 1. The flow at a glance

| Step      | Request                                               | What it accomplishes                                                      |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Authorize | App → API: `POST /v1/media/uploads`                   | Creates a pending media record and returns a signed upload target.        |
| Transfer  | App → Cloudinary: `POST upload.url`                   | Transfers the actual file using multipart form data.                      |
| Verify    | App → API: `POST /v1/media/uploads/:mediaId/complete` | API checks the stored object independently and marks valid media `ready`. |
| Use       | App → API: send a message or assign an avatar         | Links the verified media ID to application data.                          |
| Receive   | API → connected recipients: `message.created`         | Announces the persisted chat message with attachment metadata and URLs.   |

File bytes are **not** sent through Socket.IO or through the JSON upload-authorization
endpoint. For document verification, the API does download the stored document
from Cloudinary for bounded content checks; it is not an upload proxy.

## 2. Prerequisites and IDs

- Sign in through OTP and obtain a valid API `accessToken`.
- For a chat attachment, obtain a direct/group `conversationId` the sender can
  access. A recipient needs an account and membership to read the message.
- Cloudinary credentials, signed presets and media uploads must be enabled on
  the server. A disabled feature returns `503`; see [server configuration](#10-server-configuration).
- Select or record the file, then finish any compression/conversion **before**
  calculating its MIME type, byte size and optional hash. Renaming an extension
  does not convert a file.

API base URLs:

- Project deployment: `https://chateo-lhuw.onrender.com/v1`
- Local development: `http://localhost:3000/v1`

All Chateo requests in this guide require `Authorization: Bearer <accessToken>`.
Use `Content-Type: application/json` when sending JSON. The Cloudinary request
uses its returned signed fields instead: **never forward the Chateo bearer token
or refresh token to Cloudinary**.

| Value                  | Created by                     | Meaning and lifetime                                                                                    |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `clientUploadId`       | App, as a random UUID          | One logical file-upload attempt. Reuse for retries of that same request.                                |
| `media.id` / `mediaId` | API                            | The verified-media record. Save the ID returned by authorization; use it for completion and attachment. |
| `clientMessageId`      | App, as a separate random UUID | One logical chat message. Reuse when retrying the same send.                                            |
| `message.id`           | API                            | The persisted message; use it to reconcile REST responses and socket events.                            |
| `installationId`       | App, for push registration     | Unrelated to media uploads. Do not use it as the per-file or per-message ID.                            |

One media ID is not the Cloudinary `public_id` or the Cloudinary URL. Do not
substitute either of those for `mediaId`.

## 3. Supported files and purposes

Choose the purpose at authorization time; it cannot be repurposed afterward.

| Purpose              | Allowed content                       | Final destination                          |
| -------------------- | ------------------------------------- | ------------------------------------------ |
| `profile_avatar`     | JPEG, PNG, WebP                       | Signed-in user's profile picture           |
| `group_avatar`       | JPEG, PNG, WebP                       | Group picture, assigned by its owner/admin |
| `message_attachment` | Images, audio, video, documents below | Direct or group message                    |

Default maximums below may be lowered by server configuration. One MiB is
1,048,576 bytes; `sizeBytes` must be the actual positive integer byte count.

| Type             | Accepted `contentType` values                                                                               | Default maximum                                             | Per message  |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------ |
| Image            | `image/jpeg`, `image/png`, `image/webp`                                                                     | 5 MiB; stored image ≤2048 px per axis and ≤4,194,304 pixels | 1–10 images  |
| Audio/voice note | `audio/aac`, `audio/mp4`, `audio/m4a`, `audio/x-m4a`, `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/x-wav` | 20 MiB; positive duration ≤15 minutes                       | 1 audio file |
| Video            | `video/mp4`, `video/quicktime`, `video/webm`                                                                | 50 MiB; positive duration ≤5 minutes; ≤1920 px per axis     | 1 video      |
| Document         | `application/pdf`, `text/plain`, Office MIME types below                                                    | 25 MiB                                                      | 1 document   |

Office MIME types are:

- DOCX: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- XLSX: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- PPTX: `application/vnd.openxmlformats-officedocument.presentationml.presentation`

Do not mix image/audio/video/document types in the same message. Upload each file
separately, then put the ready IDs in the desired order in `attachmentMediaIds`.
Each chat attachment is permanently single-use: a new message using an already
claimed media ID is rejected, even if the original message was deleted. Replaying
the **same** message request with the same `clientMessageId` is supported.

HEIC, GIF, arbitrary ZIPs, legacy DOC/XLS/PPT, executables and macro-enabled Office
formats are not accepted. Convert unsupported image formats before authorizing.
Audio is uploaded to Cloudinary's `video` endpoint; documents use `raw`. Always
use the returned URL instead of constructing the endpoint yourself.

## 4. Walkthrough: send a chat image

### A. Authorize the upload

```http
POST /v1/media/uploads
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "clientUploadId": "7d444840-9dc0-41d1-b245-5ffdce74fad2",
  "purpose": "message_attachment",
  "contentType": "image/jpeg",
  "sizeBytes": 245000,
  "originalFilename": "class-photo.jpg"
}
```

`originalFilename` is optional display metadata, up to 255 characters. An optional
`contentSha256` accepts a 64-character hexadecimal SHA-256 of the selected file.
It participates in retry matching; document verification also checks it against
actual downloaded bytes. Image/audio/video completion does not independently
verify that hash.

Successful authorization returns **201**, including for a valid replay. Example
shape below: signatures, timestamps, URLs and IDs must come from the real response,
not this documentation.

```json
{
  "media": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "purpose": "message_attachment",
    "status": "pending",
    "type": "image",
    "contentType": "image/jpeg",
    "sizeBytes": 245000,
    "originalFilename": "class-photo.jpg",
    "width": null,
    "height": null,
    "durationMs": null,
    "secureUrl": null,
    "createdAt": "2026-09-16T10:00:00.000Z",
    "expiresAt": "2026-09-16T10:10:00.000Z",
    "completedAt": null
  },
  "upload": {
    "url": "https://api.cloudinary.com/v1_1/YOUR_CLOUD/image/upload",
    "method": "POST",
    "expiresAt": "2026-09-16T10:10:00.000Z",
    "fields": {
      "api_key": "RETURNED_API_KEY",
      "timestamp": "RETURNED_TIMESTAMP",
      "signature": "RETURNED_SIGNATURE",
      "public_id": "chateo/message-images/550e8400-e29b-41d4-a716-446655440000",
      "context": "RETURNED_CONTEXT",
      "type": "upload",
      "overwrite": "false",
      "allowed_formats": "jpg,jpeg,png,webp",
      "upload_preset": "RETURNED_PRESET",
      "transformation": "c_limit,h_2048,w_2048/q_auto"
    }
  }
}
```

Save the media ID and upload authorization with your local upload job. If an
identical request already completed, the response has `media.status: "ready"`
and `upload: null`. Skip transfer/completion and proceed to use that media, subject
to the single-use rule for chat attachments.

### B. Transfer the actual file

Send **one multipart POST** to the exact `upload.url`:

| Multipart part               | Value                              |
| ---------------------------- | ---------------------------------- |
| `file`                       | The selected file's binary content |
| Every key in `upload.fields` | Its exact returned string value    |

Do not send `{ "file": "file:///..." }` as JSON or just submit a file path as text.
In Postman, `file` must be a **File** form-data field; signed fields are **Text**.
Do not change the public ID, preset, context, transformation, format restrictions
or timestamp. Do not add a Cloudinary API secret.

When using browser `FormData`, let the HTTP implementation supply the multipart
`Content-Type` and boundary; do not set it to JSON or manually set a bare
`multipart/form-data` header. See [MDN's FormData guidance](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest_API/Using_FormData_Objects).

Cloudinary's successful response confirms storage, **not** acceptance by Chateo.
Do not send its `secure_url` to the message endpoint or assume the media is ready.
The app uses signed-upload authorization; this is distinct from private media
delivery. See [Cloudinary's signed upload documentation](https://cloudinary.com/documentation/upload_images#authenticated_requests).

### C. Complete verification

After Cloudinary accepts the upload, call Chateo with **no request body**:

```http
POST /v1/media/uploads/550e8400-e29b-41d4-a716-446655440000/complete
Authorization: Bearer <accessToken>
```

The API independently checks ownership, expected provider ID/context, resource
type, actual format, size and HTTPS URL. It also checks dimensions for images,
duration for audio, and dimensions/duration/a visual stream for video. Documents
receive additional file-content validation; this is not antivirus scanning.

Success returns **200** and the media object directly, not `{ "media": ... }`:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "purpose": "message_attachment",
  "status": "ready",
  "type": "image",
  "contentType": "image/jpeg",
  "sizeBytes": 182400,
  "originalFilename": "class-photo.jpg",
  "width": 1280,
  "height": 960,
  "durationMs": null,
  "secureUrl": "https://res.cloudinary.com/YOUR_CLOUD/image/upload/chateo/message-images/550e8400-e29b-41d4-a716-446655440000.jpg",
  "createdAt": "2026-09-16T10:00:00.000Z",
  "expiresAt": "2026-09-16T10:10:00.000Z",
  "completedAt": "2026-09-16T10:00:15.000Z"
}
```

Stored image size can differ from declared input size after image normalization.
Use the verified response for rendering. A ready asset's `expiresAt` remains the
old upload deadline; it does not mean the ready URL expires then. Repeating
completion for your already-ready media returns it without re-uploading.

### D. Persist the chat message

Use the same route for direct and group conversations:

```http
POST /v1/conversations/{conversationId}/messages
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "clientMessageId": "7d444840-9dc0-41d1-b245-5ffdce74fad4",
  "text": "Photo from today's class",
  "attachmentMediaIds": ["550e8400-e29b-41d4-a716-446655440000"]
}
```

The route returns **200** for both first send and identical replay. Caption `text`
is optional; omit it for a media-only message. You may also include a valid
`replyToMessageId`. Do not send your own `kind`, attachment URLs, sizes or duration:
the API derives these from verified media. Unknown request properties are rejected.

Relevant fields from the message response (other message fields omitted):

```json
{
  "id": "c0427bea-83af-4487-8e88-673d1ba0fb4a",
  "conversationId": "ce0d09f4-082e-4e54-9d59-6b29be255d58",
  "clientMessageId": "7d444840-9dc0-41d1-b245-5ffdce74fad4",
  "kind": "image",
  "text": "Photo from today's class",
  "attachments": [
    {
      "mediaId": "550e8400-e29b-41d4-a716-446655440000",
      "type": "image",
      "contentType": "image/jpeg",
      "sizeBytes": 182400,
      "width": 1280,
      "height": 960,
      "url": "https://res.cloudinary.com/YOUR_CLOUD/image/upload/chateo/message-images/550e8400-e29b-41d4-a716-446655440000.jpg"
    }
  ]
}
```

The message owns the ready attachment after this step. To send that file in a
different message/conversation, start a separate upload with a new upload ID.

### E. Receive and render

The server emits `message.created` on the authenticated `/chat` Socket.IO
namespace for eligible connected participants. Its payload is the message
object directly, not `{ "message": ... }`. It contains metadata/URLs, not bytes.

- Render by `attachments[].type`: image, audio player, video player, or document.
- Use `attachments[].url`; upload/completion objects instead use `secureUrl`.
- Audio/video duration is `durationMs`, in milliseconds. Documents use `filename`.
- Merge the REST result and socket event by `message.id`; the sender can receive
  both. Use `clientMessageId` to reconcile the sender's optimistic message.
- Identical send retries do not emit a second creation event. Realtime delivery
  is best-effort; on reconnect fetch `GET /v1/conversations/:conversationId/messages`.

See the [Socket.IO walkthrough](postman/README.md) for connection and receipt
testing and [MESSAGING.md](MESSAGING.md) for edits, replies and deletions.

## 5. Profile and group pictures

The authorization, transfer and completion steps stay the same. Change the
purpose and the final request, and do not also send that upload as a chat message.

### Profile picture

Authorize with `purpose: "profile_avatar"`, complete, then:

```http
PUT /v1/me/avatar
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "mediaId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Returns **200** with the user profile and its verified `avatarUrl`. The signed-in
user must own the upload. Remove the picture using `DELETE /v1/me/avatar`
(**204**, no response body). `PATCH /v1/me` is for the display name; it does not
accept arbitrary `avatarUrl` values.

### Group picture

Authorize with `purpose: "group_avatar"`, complete, then:

```http
PUT /v1/conversations/{conversationId}/avatar
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "mediaId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Returns **200** with the group response. The acting user must own the upload and
be a group owner/admin. Remove it with `DELETE /v1/conversations/:conversationId/avatar`
(**200**, group response). Removal clears the reference, not the provider file.

For a new group, upload/complete its image first, then include `avatarMediaId`
in `POST /v1/conversations/group` alongside `name` and `participantIds`. Notice
that group creation uses **`avatarMediaId`**, while the dedicated avatar PUT uses
**`mediaId`**. Repeatedly selecting the same valid avatar is supported.

## 6. Client-side reference example

This is a browser JavaScript example for learning the HTTP contract, **not a
drop-in React Native uploader**. Native apps should use their file/network library
to append the binary file and preserve the same fields and sequence. A local URI
alone is not a browser `File`.

Keep the JSON API client separate from the Cloudinary upload request so default
authorization/JSON headers cannot leak onto the upload. The helpers perform one
attempt at each step; use the recovery table below instead of blindly repeating
the entire flow. Authentication refresh and upload progress are application concerns.

```js
function createMediaClient({ baseUrl, getAccessToken, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/$/, ''); // Already includes /v1.

  async function requireSuccess(response, stage) {
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`${stage} failed (HTTP ${response.status}).`);
      error.status = response.status;
      error.code = data?.code ?? `HTTP_${response.status}`;
      error.stage = stage;
      throw error;
    }
    return data;
  }

  async function api(path, method, body, signal) {
    const headers = { Authorization: `Bearer ${await getAccessToken()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return requireSuccess(
      await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: 'error',
        credentials: 'omit',
      }),
      path,
    );
  }

  return {
    authorize: (input, signal) => api('/media/uploads', 'POST', input, signal),
    async transfer(upload, file, signal) {
      const expiresAt = Date.parse(upload?.expiresAt ?? '');
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new Error('Upload authorization is missing or expired.');
      }
      const target = new URL(upload.url);
      if (
        target.protocol !== 'https:' ||
        target.host !== 'api.cloudinary.com' ||
        target.username ||
        target.password
      ) {
        throw new Error('Unexpected Cloudinary upload target.');
      }
      const form = new FormData();
      for (const [name, value] of Object.entries(upload.fields)) {
        form.append(name, value);
      }
      form.append('file', file, file.name);
      await requireSuccess(
        await fetchImpl(target.href, {
          method: 'POST',
          body: form,
          signal,
          redirect: 'error',
          credentials: 'omit',
          // No Authorization or manually set Content-Type header.
        }),
        'cloudinary-transfer',
      );
    },
    complete: (mediaId, signal) =>
      api(
        `/media/uploads/${encodeURIComponent(mediaId)}/complete`,
        'POST',
        undefined,
        signal,
      ),
    sendMessage: (conversationId, input, signal) =>
      api(
        `/conversations/${encodeURIComponent(conversationId)}/messages`,
        'POST',
        input,
        signal,
      ),
    setProfileAvatar: (mediaId, signal) =>
      api('/me/avatar', 'PUT', { mediaId }, signal),
    setGroupAvatar: (conversationId, mediaId, signal) =>
      api(
        `/conversations/${encodeURIComponent(conversationId)}/avatar`,
        'PUT',
        { mediaId },
        signal,
      ),
  };
}
```

Example first attempt in an async file-selection handler. `selectedFile` is a
JPEG/PNG/WebP browser `File`; `conversationId` and `getCurrentAccessToken` come
from the signed-in application. Persist the IDs, exact request metadata and
current stage before network operations so an app restart can resume safely.

```js
const client = createMediaClient({
  baseUrl: 'https://chateo-lhuw.onrender.com/v1',
  getAccessToken: getCurrentAccessToken,
});
const controller = new AbortController();
const signal = controller.signal;

// Create these once for the user's action, not again inside a retry loop.
const clientUploadId = crypto.randomUUID();
const clientMessageId = crypto.randomUUID();
const uploadInput = {
  clientUploadId,
  purpose: 'message_attachment',
  contentType: selectedFile.type,
  sizeBytes: selectedFile.size,
  originalFilename: selectedFile.name,
};

const authorization = await client.authorize(uploadInput, signal);
let readyMedia = authorization.media; // Persist readyMedia.id now.
if (readyMedia.status !== 'ready') {
  await client.transfer(authorization.upload, selectedFile, signal);
  // If completion fails transiently, retry only this next call.
  readyMedia = await client.complete(readyMedia.id, signal);
}
if (readyMedia.status !== 'ready') throw new Error('Media is not ready.');

const messageInput = {
  clientMessageId,
  text: "Photo from today's class",
  attachmentMediaIds: [readyMedia.id],
};
// If the response is lost, retry this exact request with the same IDs/body.
const message = await client.sendMessage(conversationId, messageInput, signal);
```

For an avatar, change the purpose and replace the send with the corresponding
avatar helper. For audio/video/documents, use the correct MIME type and respect
their limits. Do not modify metadata after a request has been authorized.

## 7. Swagger and Postman exercise

Swagger's media endpoint accepts metadata JSON, not a file picker. Use Swagger
for the API calls and a separate multipart request in Postman for the file:

1. In Swagger, authorize with your API access token. Under **media**, execute
   `POST /v1/media/uploads` using a fresh UUID and the actual selected file size.
2. Save `media.id`. Copy `upload.url` into a new Postman HTTP `POST` request.
3. Set that Postman request's authorization to **No Auth**, not inherited bearer
   auth. Under **Body → form-data**, add every returned signed field as **Text**,
   then add `file` as **File** and select the actual matching file. Do not manually
   set the multipart Content-Type header. Keep signed values local; do not publish
   the request with real credentials or signatures.
4. Send to Cloudinary. After success, return to Swagger and execute
   `POST /v1/media/uploads/{mediaId}/complete` with the saved ID and no body.
5. Confirm `status: "ready"`. Send that ID using **messages**, or select it using
   the matching **profile/group avatar** endpoint.
6. For a chat, check the second user's `message.created` event or fetch message
   history. Open/render the attachment using the returned URL.

If Cloudinary reports a signature/preset problem, compare **all** multipart fields
against the API response. Do not fix it by turning the preset unsigned or putting
the Cloudinary secret into the client.

## 8. Retries, expiry and cancellation

Persist an upload job per file: user/account ID, file reference, original metadata,
`clientUploadId`, returned `mediaId`, current stage, and intended destination.
Keep `clientMessageId` and the exact send body with the message draft. Use the
app's protected credential storage separately; do not put tokens into logs.
Cancel/stop jobs on logout or account switch rather than replaying another user's
job under the new account.

| Situation                                                        | Correct recovery                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization response lost                                      | Repeat the same authorization JSON with the same `clientUploadId`.                                                                                                      |
| Authorization replay returns `ready` and `upload: null`          | Skip uploading and completing again; use the returned media if available for the intended operation.                                                                    |
| Cloudinary transfer times out and success is uncertain           | Try API completion for the saved media ID first. If it returns `MEDIA_UPLOAD_NOT_READY`, back off; if still absent, retry the same signed transfer before its deadline. |
| Cloudinary says the public ID already exists                     | Do not overwrite or pick an arbitrary new public ID. Complete the existing media and let the API verify it.                                                             |
| Transfer succeeded; completion returns a transient storage error | Retry completion only. Do not start another upload.                                                                                                                     |
| Message send response lost                                       | Retry the exact send body and `clientMessageId`; the server returns the existing message without claiming the attachment twice.                                         |
| User changes the file, purpose, caption or destination           | Changed upload data needs a new upload ID; changed send data needs a new message ID. Do not attach a media ID already consumed by an earlier message.                   |
| `401` from Chateo                                                | Refresh using the app's auth flow, then retry the failed API step with unchanged IDs; sign in again if refresh fails.                                                   |
| Upload authorization expired                                     | Start a new upload attempt with a new `clientUploadId`; do not reuse the expired signature.                                                                             |

The default authorization deadline is **600 seconds**, configurable by
`MEDIA_UPLOAD_TTL_SECONDS`. Both transfer and initial completion need to finish
before the returned `expiresAt`; use that value rather than assuming ten minutes.
Retrying authorization does not extend the original deadline. Already-ready
media does not become invalid solely because this upload deadline passed.

Use bounded retries/backoff and a cancelable request; do not retry invalid file
types, permanent validation errors or ownership errors indefinitely. Aborting a
client request cannot guarantee the server/provider did not finish it. Reconcile
with completion or the original idempotent send before starting something new.
There is no general upload-cancellation/delete-media endpoint in this API;
unreferenced uploads are handled by the cleanup policy below.

## 9. Errors and troubleshooting

Chateo errors use this shape (Cloudinary responses have their own format):

```json
{
  "statusCode": 409,
  "code": "MEDIA_UPLOAD_NOT_READY",
  "message": "Cloudinary has not received this upload yet.",
  "path": "/v1/media/uploads/550e8400-e29b-41d4-a716-446655440000/complete",
  "timestamp": "2026-09-16T10:00:10.000Z"
}
```

Some errors additionally contain `details`. Treat `code` as the machine-readable
value; do not match the English message to decide whether to retry.

| HTTP / code                                                                                           | Meaning / action                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 VALIDATION_ERROR`                                                                                | Invalid UUID, purpose, MIME type, empty/noninteger size, a size above the DTO ceiling, or extra properties. Correct the input.                |
| `413 MEDIA_UPLOAD_TOO_LARGE`                                                                          | Valid request exceeds the server's configured size limit; resize/compress or pick another file and authorize a new attempt.                   |
| `401`                                                                                                 | Missing, expired or revoked API credentials. Restore authentication.                                                                          |
| `404 MEDIA_UPLOAD_NOT_FOUND`                                                                          | Missing upload or one owned by another user. Do not expose whether another user's upload exists.                                              |
| `409 MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT`                                                               | Same upload UUID with different normalized metadata. Use a new ID for a genuinely new upload.                                                 |
| `409 MEDIA_UPLOAD_NOT_READY`                                                                          | Expected provider object not yet found. Finish transfer or retry completion with bounded backoff.                                             |
| `409 MEDIA_UPLOAD_VERIFICATION_FAILED`                                                                | Provider metadata/content violates the signed request or limits. Fix the actual file/preset issue and start a new upload.                     |
| `409 MEDIA_UPLOAD_NOT_COMPLETABLE` / `MEDIA_UPLOAD_NOT_REUSABLE`                                      | The record is failed/deleted or otherwise not usable for that operation. Start a new attempt after correcting the cause.                      |
| `410 MEDIA_UPLOAD_EXPIRED`                                                                            | The pending upload deadline passed. New upload ID and authorization required.                                                                 |
| `502 MEDIA_STORAGE_UNAVAILABLE`                                                                       | Provider access/validation temporarily failed. Retry the failed step within the deadline; check server/provider configuration if it persists. |
| `503 MEDIA_UPLOADS_DISABLED`                                                                          | Global uploads/required Cloudinary configuration unavailable. Server setup is needed.                                                         |
| `503 MEDIA_AUDIO_UPLOADS_DISABLED`, `MEDIA_VIDEO_UPLOADS_DISABLED`, `MEDIA_DOCUMENT_UPLOADS_DISABLED` | The requested attachment kind has no configured preset.                                                                                       |
| `409 MESSAGE_ATTACHMENT_UNAVAILABLE`                                                                  | Media is pending, foreign, wrong-purpose, already claimed, invalid, or the attachment combination is unsupported.                             |
| `409 MESSAGE_IDEMPOTENCY_CONFLICT`                                                                    | An existing message ID was retried with different original content, attachments/order, reply or conversation.                                 |
| `409 PROFILE_AVATAR_NOT_READY` / `GROUP_AVATAR_UNAVAILABLE`                                           | Complete and select an owned upload with the matching avatar purpose.                                                                         |
| `403` on group avatar changes                                                                         | Acting member is not allowed to change the group picture.                                                                                     |
| `404` on chat operations                                                                              | Conversation is inaccessible; membership/direct-chat blocking can prevent access.                                                             |
| `429`                                                                                                 | Back off; avoid tight retry loops.                                                                                                            |

If the upload is ready but a copied URL cannot be displayed/downloaded, also
check the Cloudinary account's delivery restrictions and the client's supported
codecs/viewer. Do not bypass API validation to work around a rendering problem.

## 10. Server configuration

Apply the repository's pending Prisma migrations before starting the matching API
build. Keep real values in the server's secret/environment configuration, not in
source control, the mobile bundle, screenshots or shared Postman environments.

Required for uploads:

```dotenv
MEDIA_UPLOADS_ENABLED=true
CLOUDINARY_CLOUD_NAME=<your-cloud-name>
CLOUDINARY_API_KEY=<your-api-key>
CLOUDINARY_API_SECRET=<server-only-secret>
CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET=<signed-image-preset>
```

Despite its name, the image preset is shared by profile pictures, group pictures
and chat images. Enable other kinds only after creating their separate presets:

| Setting                                   | Signed preset restrictions                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET` | JPEG/PNG/WebP; ≤5,242,880 bytes; allow the API-assigned public ID and signed image transformation. |
| `CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET`     | AAC/M4A/MP3/OGG/WAV; ≤20,971,520 bytes; Cloudinary `video` resource type.                          |
| `CLOUDINARY_CHAT_VIDEO_UPLOAD_PRESET`     | MP4/MOV/WebM; ≤52,428,800 bytes; do not change format or metadata relied on by verification.       |
| `CLOUDINARY_CHAT_DOCUMENT_UPLOAD_PRESET`  | PDF/TXT/DOCX/XLSX/PPTX; ≤26,214,400 bytes; Cloudinary `raw`; no transformations.                   |

Use signed, not unsigned, presets. Enforce maximum bytes on Cloudinary too,
because API completion happens **after** transfer. Keep overwriting disabled;
preserve the signed public ID/context and match any stricter server limits.
Missing optional presets disable only their respective kind.

See [.env.example](.env.example) for the supported size/duration/folder/TTL settings.
The API applies image normalization but does not provide video transcoding,
thumbnail generation or a resumable/chunked upload workflow. Prepare compatible
videos within the declared limits before authorization. Test with a non-sensitive
file in the configured environment before relying on a live integration.

## 11. Security and cleanup

- The API secret stays on the server. A returned API key is not that secret;
  signed fields are short-lived upload authorizations and should not be shared.
- Only the upload owner may complete/use it. Knowing a media UUID does not grant
  access to another user's media record.
- Document checks cover file-type/container validation, not full malware scanning
  or document sanitization. Do not present arbitrary documents as proven safe.
- Current delivery uses public Cloudinary `upload` URLs. **Anyone with a copied
  URL may retrieve the file.** API membership checks are not private CDN delivery,
  and this feature does not provide end-to-end media encryption.
- Deleting a message creates a tombstone; clearing chat hides history for that
  member. Neither operation revokes a copied URL or releases the attachment ID.
- Pending/failed uploads are cleaned up after the signed-upload safety window;
  cleanup is not immediate on expiry. It requires media uploads to be enabled.
- Completed unused uploads and replaced avatars are eligible for cleanup only
  when `MEDIA_UNUSED_CLEANUP_ENABLED=true`. The default grace period is 24 hours,
  configurable with `MEDIA_UNUSED_RETENTION_HOURS` (minimum 24). Do not treat
  unattached ready uploads as permanent storage.
- Current avatars and permanently claimed chat attachments are protected from
  unused-media cleanup. After avatar replacement/removal, the first unreferenced
  observation starts a fresh grace period. Provider deletion is permanent unless
  independently backed up.

See [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) for exact retirement, retry and
reference-protection behavior. Private delivery, URL revocation and malware
scanning require additional work; they are not implied by signed uploads.

## 12. End-to-end acceptance checklist

Run with test accounts and non-sensitive files. A passing mocked test suite is
not proof that deployed Cloudinary credentials/presets are configured correctly.

- [ ] Image authorization returns a pending media ID and signed fields.
- [ ] Multipart upload succeeds without an API bearer token on the Cloudinary request.
- [ ] Completion returns `ready` and verified dimensions/size/URL.
- [ ] A direct-chat image message appears once for sender and recipient.
- [ ] The same flow works for a group, audio recording, video and supported document.
- [ ] Profile/group avatar assignment uses the right purpose and final field name.
- [ ] Repeating completion and the identical message send creates no duplicate media/message.
- [ ] Simulated lost responses recover using the original IDs; an uncertain transfer
      is checked through completion before retrying upload.
- [ ] Wrong-purpose, foreign, already-claimed and unverified attachments are rejected.
- [ ] Invalid MIME types, oversized files and expired authorizations show actionable errors.
- [ ] On reconnect, REST history restores messages even if a socket event was missed.
- [ ] The team understands public-URL privacy and the limits of document validation.

### Contract sources

This guide follows the repository implementation rather than assuming every
Cloudinary feature is exposed by Chateo:

- [Upload routes](src/media/media.controller.ts), [request validation](src/media/dto/create-media-upload.dto.ts), [response shapes](src/media/dto/media-response.dto.ts).
- [Verification/idempotency service](src/media/media.service.ts), [format limits](src/media/attachment-formats.ts).
- [Send-message input](src/messages/dto/send-message.dto.ts), [attachment responses](src/messages/dto/message-response.dto.ts).
- [Profile assignment](src/media/profile-avatar.controller.ts), [group assignment](src/conversations/conversations.controller.ts), [creation events](src/realtime/realtime-message-events.publisher.ts).
