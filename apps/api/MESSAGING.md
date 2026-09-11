# Advanced messages and video/document attachments

These backend features work in both direct and group conversations. The mobile
UI is unchanged. All routes below require a valid bearer token and current
conversation membership. Swagger includes request examples.

## Deployment

Apply `20260909100000_add_advanced_messages` before running the new API build.
It adds `VIDEO`/`DOCUMENT` message kinds, replies, revisions, tombstones, original
send fingerprints, and per-user reactions. Deploy all pending migrations in
order, including the preceding group-avatar migration:

```bash
npm run prisma:deploy --workspace @chateo/api
npm run build
```

Configure the existing Cloudinary credentials and image preset, then these
**separate signed presets** before enabling their respective upload types:

| Environment variable                     | Cloudinary preset restrictions                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `CLOUDINARY_CHAT_VIDEO_UPLOAD_PRESET`    | Signed, MP4/MOV/WebM, max 52,428,800 bytes                                   |
| `CLOUDINARY_CHAT_DOCUMENT_UPLOAD_PRESET` | Signed, raw PDF/TXT/DOCX/XLSX/PPTX, max 26,214,400 bytes; no transformations |

Do not enable unsigned uploads. Keep overwrites disabled and preserve the
server-assigned public ID, context, and format. Video uploads are not transcoded
by this API: clients must prepare clips within the limits below. Missing presets
return `503 MEDIA_VIDEO_UPLOADS_DISABLED` or
`503 MEDIA_DOCUMENT_UPLOADS_DISABLED`; existing image/audio uploads still work.
The global `MEDIA_UPLOADS_ENABLED` flag must also be true.

Limits may be lowered with `MEDIA_MAX_CHAT_VIDEO_BYTES`,
`MEDIA_MAX_CHAT_VIDEO_DURATION_MS`, and `MEDIA_MAX_CHAT_DOCUMENT_BYTES`. Values
above the documented ceilings prevent startup. Enforce the matching byte limits
in Cloudinary too: completion validation happens **after** a direct upload.

## Replies, edits, reactions, deletion, and search

Base path: `/v1/conversations/:conversationId/messages`.

| Method and suffix               | Request                                             | Result                                  |
| ------------------------------- | --------------------------------------------------- | --------------------------------------- |
| `POST` base path                | Existing send body plus optional `replyToMessageId` | Persist/replay a reply                  |
| `GET /:messageId`               | —                                                   | Current message or deletion placeholder |
| `PATCH /:messageId`             | `{ "text": "Updated", "expectedVersion": 0 }`       | Sender-only edit                        |
| `DELETE /:messageId`            | —                                                   | Sender-only delete for everyone         |
| `PUT /:messageId/reaction`      | `{ "emoji": "👍" }`                                 | Set/replace your reaction               |
| `DELETE /:messageId/reaction`   | —                                                   | Remove your reaction                    |
| `GET /search?q=lesson&limit=20` | Optional `cursor`                                   | Newest-first matching messages          |

Every message response now includes `replyToMessageId`, `editedAt`, `deletedAt`,
`version` (initially zero), and `reactions: [{ userId, emoji }]`.

- Reply targets must be nondeleted messages in the same conversation and visible
  after the sender's clear-history boundary. Invalid targets return
  `409 MESSAGE_REPLY_UNAVAILABLE`. A reply stores the target ID, not a duplicate
  of its original text. Resolve it through the single-message GET route; show an
  unavailable/deleted preview if the target is hidden or deleted later.
- Only the sender can edit/delete, including in groups; group admins do not gain
  message-moderation permissions. Mutations in blocked direct chats return 404.
  Existing history/search remains readable under the established history policy.
- Editing changes text or an attachment caption only. Text has a 4,000-character
  limit; use `null` to remove a caption, but text-only messages cannot be blank.
  Attachments, sender, creation time and reply target are immutable. Stale edits
  return `409 MESSAGE_VERSION_CONFLICT`; fetch the latest version before retrying.
  Retrying text that is already current is a successful no-op.
- One reaction per user per message, selected from 👍 ❤️ 😂 😮 😢 🙏. PUT replaces
  the caller's previous selection; DELETE removes only that caller's reaction.
  Identical PUTs and repeated removals are no-ops.
- Deletion removes the stored text and reactions and hides attachments/reply
  metadata in all API responses. A stable tombstone remains, keeping message IDs,
  ordering and receipt boundaries intact. Repeated deletion is a successful no-op.
  Edits/reactions on a deleted message return `409 MESSAGE_DELETED`.
- Edits/reactions/deletions do not bump conversation activity or change unread
  counters. A previously unread deleted message remains an unread placeholder
  until read/cleared. The latest-message preview displays `Message deleted`.
- Send retries compare a fingerprint of the **original request**, including reply
  ID and ordered media IDs. Resending that body with the original client ID returns
  the current edited message or tombstone, never the deleted text. A different
  body still returns `409 MESSAGE_IDEMPOTENCY_CONFLICT`.
- Search matches literal, case-insensitive text and captions, not filenames or
  document contents. `q` is trimmed and must be 2–100 characters. Deleted/cleared
  messages are excluded. Search cursors are bound to the exact query and chat;
  they cannot be reused for normal history or another query/conversation.

`DELETE` on the **base path** still means clear-history-for-me, not delete for
everyone. It does not alter shared message rows.

## Socket updates and reconnection

`message.created` keeps its existing message-shaped payload with the additional
fields above. New events use a full snapshot:

```ts
for (const event of [
  'message.updated',
  'message.deleted',
  'message.reaction.updated',
]) {
  socket.on(event, ({ message, actorId, occurredAt }) => {
    // Find message by message.id. Apply only a newer message.version.
    // Respect the caller's clear-history boundary before adding anything.
    // Refresh the conversation preview if this is its latest message.
  });
}
```

Versions increase only for real edits, deletions or reaction changes. Ignore
older/equal snapshots, including delayed `message.created` after an edit/delete.
Events reach current eligible members' active sessions, excluding recipients who
cleared that message and members added after the mutation. Membership, direct
blocks, session revocation and token expiry are rechecked before delivery.
Delivery is best-effort, not durable replay: refetch history and the conversation
on reconnect. These mutations are REST commands, not client-emitted socket commands.

## Upload and send a video or document

Use the same three-step lifecycle as images and audio:

1. `POST /v1/media/uploads` with a new `clientUploadId`,
   `purpose: "message_attachment"`, exact `contentType`, `sizeBytes`, and optional
   `originalFilename`/`contentSha256`.
2. Upload the file directly to the returned Cloudinary URL using all returned
   signed fields unchanged. Never send the API bearer token to Cloudinary.
3. `POST /v1/media/uploads/:mediaId/complete`, then send the ready ID:

```json
{
  "clientMessageId": "7d444840-9dc0-41d1-b245-5ffdce74fad4",
  "text": "Today's lesson",
  "attachmentMediaIds": ["550e8400-e29b-41d4-a716-446655440002"]
}
```

Send it to the message base path for either a direct or group conversation.
The API derives `kind` from verified media; do not supply your own URLs or kind.
One video **or** one document per message, with an optional caption/reply. Images
still allow up to ten, audio one; mixing types in one message is rejected.
Only the owner can claim a ready asset, and every asset is permanently single-use.
Deleting a message does not release its media for reuse.

| Type     | Accepted MIME types/formats                                              | Maximums                            | Attachment fields                                                                              |
| -------- | ------------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Video    | `video/mp4`, `video/quicktime` (MOV), `video/webm`                       | 50 MiB, 5 minutes, 1920 px per axis | `mediaId`, `type: "video"`, `contentType`, `sizeBytes`, `width`, `height`, `durationMs`, `url` |
| Document | `application/pdf`, `text/plain` (UTF-8), DOCX/XLSX/PPTX MIME types below | 25 MiB                              | `mediaId`, `type: "document"`, `contentType`, `sizeBytes`, `filename`, `url`                   |

Office MIME types:

- DOCX: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- XLSX: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- PPTX: `application/vnd.openxmlformats-officedocument.presentationml.presentation`

Executables, generic ZIP files, legacy DOC/XLS/PPT and macro-enabled Office formats
are not accepted. Returned document names remove path/control/bidi characters and
use the server-selected extension. Cloudinary raw IDs include the extension; video
and audio share the provider's `video` resource type. Document attachment URLs use
`fl_attachment` for download delivery. See Cloudinary's
[upload parameters](https://cloudinary.com/documentation/upload_parameters) and
[attachment delivery flag](https://cloudinary.com/documentation/transformation_reference#fl_attachment).

Completion checks provider ownership/context, resource type, format and size.
Video additionally requires an actual visual stream, dimensions and duration.
Documents additionally undergo a server-side, bounded download from the exact
`https://res.cloudinary.com/<configured-cloud>/raw/upload/...` object (no redirects,
10-second timeout, 25 MiB cap, two concurrent validations per process).
Bytes must exactly match the declared size and SHA-256 when provided. The current
verifier does not support custom Cloudinary delivery domains.

PDF header/trailer, strict UTF-8 text, and bounded Office ZIP-container checks
reject obvious mismatches, encrypted archives, traversal, oversized expanded data,
macro/embedded executable entries and unsafe XML declarations. Network/storage
errors stay retryable; invalid content fails the upload and enters cleanup.

These are **file-type checks, not antivirus or comprehensive document sanitization**.
Add malware scanning/quarantine before treating arbitrary documents as safe.
Cloudinary delivery is still public: API authorization or message deletion does
not revoke a URL someone already has. Private delivery and provider-byte purging
are separate work. Video codec compatibility is also device-dependent; there is
no transcoding or thumbnail-generation pipeline in this slice.

## Verification

Unit tests cover metadata/signing, bounded document validation, mutation policy,
idempotency and realtime visibility. Local in-memory E2E tests cover REST + sockets
for replies/edits/reactions/deletion/search, every accepted upload format, invalid
completions and direct/group video/document delivery. Real PostgreSQL tests in
`test/advanced-messages.integration-spec.ts` cover concurrent edits/reactions,
same-chat reply foreign keys, literal search/clear boundaries and permanent media
claims after deletion. Run them only against the dedicated integration database
described in [README.md](README.md#database). A live Cloudinary upload/completion
smoke test is still required once the signed presets are configured.
