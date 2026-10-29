# Chat details: profiles, media, links and starred messages

Use these APIs for the contact/group information screen. They work with both
direct and group conversations. Every request requires
`Authorization: Bearer <accessToken>` and current conversation membership.

## Endpoint map

All paths below start with `/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/me` | Your profile, bio and privacy preferences |
| `PATCH` | `/me` | Change your name, bio or sharing preferences |
| `GET` | `/conversations/:conversationId` | Read group details, including description, creator, members and roles |
| `PATCH` | `/conversations/:conversationId` | Owners/admins update group name, description or photo |
| `GET` | `/conversations/:conversationId/participants/:userId` | Read a current participant's profile |
| `GET` | `/conversations/:conversationId/shared-media` | Paginated messages with attachments |
| `GET` | `/conversations/:conversationId/shared-links` | Paginated messages containing HTTP(S) links |
| `GET` | `/conversations/:conversationId/starred-messages` | Your starred messages in this chat |
| `GET` | `/conversations/:conversationId/messages/:messageId/star` | Your star state for one message |
| `PUT` | `/conversations/:conversationId/messages/:messageId/star` | Star a message for yourself |
| `DELETE` | `/conversations/:conversationId/messages/:messageId/star` | Remove your star |

`GET /conversations/:conversationId` continues to return a conversation summary.
For a direct chat, take `otherParticipant.id` from that response and use the
participant-profile endpoint. For a group, use the selected participant's ID.
Media, links and stars are fetched separately so opening the chat list does not
download a complete gallery.

## Group information screen

Every current group member can call `GET /conversations/:conversationId`.
For `type: "group"`, the response includes:

- `name`, `avatarUrl`, and nullable `description`.
- `createdById` and `createdAt`: the original creator and creation date.
- `memberCount`: current members, including the owner.
- `participants`: current member IDs, display names, photos and
  `owner`/`admin`/`member` roles.
- `role` and `settings`: the signed-in member's role and personal chat settings.

An ownership transfer changes the current owner in `participants`; it does not
change `createdById`. The original creator may have left. Resolve a creator's
display name from the current roster when available, without assuming they are
still a member. Former members and outsiders receive 404 when requesting group
details. An existing group without a description returns `description: null`.

Owners and admins can update just the description:

```http
PATCH /v1/conversations/:conversationId
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "description": "React Native classroom discussions and resources."
}
```

Descriptions are trimmed and limited to 500 characters. Omit the field to leave
it unchanged; send `null` or an empty string to clear it. The same optional field
is accepted during `POST /conversations/group`. Ordinary members can read but
cannot edit group metadata (403). The existing
`conversation.metadata.updated` socket event now includes `description`
alongside `name` and `avatarUrl`; unchanged updates do not produce another event.
Refetch details after membership/ownership events to update the count and roles.

Use the same `shared-media`, `shared-links`, and `starred-messages` routes with
the group's conversation ID. Media and links are shared conversation content;
stars remain private to the caller. Tapping a member opens the
participant-profile endpoint, which still applies phone/last-seen opt-in and
blocking rules. The group roster itself does not expose these private fields.

## Profile and privacy

Update your own profile with any combination of these fields:

```http
PATCH /v1/me
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "bio": "Learning React Native",
  "sharePhoneNumber": true,
  "shareLastSeen": false
}
```

Both sharing preferences default to `false`, including for existing users.
Use actual JSON booleans, not strings. `bio` is trimmed and limited to 160
characters; send `""` to remove it. `null` is rejected for these update fields.
Only setting a valid `displayName` completes onboarding; changing a bio or
privacy preference alone does not. Avatar assignment still uses the existing
verified-media endpoints.

The participant response has this shape:

```json
{
  "id": "00000000-0000-4000-8000-000000002802",
  "displayName": "Ada",
  "avatarUrl": null,
  "bio": "Learning React Native",
  "phoneNumber": "+2348012345678",
  "lastSeenAt": null
}
```

Phone number and last-seen are returned only if the participant enabled their
respective setting, or if you are reading your own profile. Both users must
currently belong to the requested conversation. A block in either direction,
missing participant or inaccessible conversation returns
`404 PARTICIPANT_NOT_FOUND`. Bio is visible to unblocked current participants.
User search continues to return only its existing public summary fields.

`GET /me`, OTP verification, token refresh and avatar assignment return your
bio, sharing preferences and last-seen alongside the existing user fields.
These are additive response fields. Keep existing clients tolerant of new
fields. Changing privacy settings does not broadcast a socket event: refetch
participant details on screen focus, and discard cached details after a block,
membership change or account switch. Treat `null` as unavailable; do not infer
whether a timestamp is unknown or intentionally hidden.

## Last-seen and online status

`lastSeenAt` records the last authenticated socket observation in PostgreSQL.
It is updated on connection, approximately every 30 seconds while a valid
socket remains connected, and on an authenticated disconnect. Concurrent or
delayed writes cannot move it backwards. It survives an API restart and remains
`null` for users who have not connected since this feature was deployed.

Continue using `presence.subscribe` and `presence.changed` for online/offline
status. A timestamp by itself does not indicate that someone is offline; another
device may still be connected. Display “Online” while presence is online, and
use a shared last-seen value otherwise. After an offline event, refetch the
profile. An abrupt process shutdown or failed persistence write can leave an
older observation; never present it as an exact logout time. The existing
process-local presence deployment limitation still applies; this change does
not add a distributed online-presence adapter.

## Shared-media gallery

```http
GET /v1/conversations/:conversationId/shared-media?kind=image&limit=20
```

`kind` may be `image`, `audio`, `video` or `document`. Omit it for all kinds.
The response is the existing `{ items, pageInfo }` message-history envelope.
Each item is a complete message with its `attachments`; flatten attachments in
their existing order to render a gallery. Keep the message ID for “Go to
message”. One image message can contain multiple photos, so `limit` counts
messages, not files. Upload authorization, Cloudinary transfer, completion and
sending remain as described in [MEDIA_UPLOADS.md](MEDIA_UPLOADS.md).

Only attachments already sent in visible messages appear. Pending/unused
uploads and profile/group avatars do not appear in the gallery.

## Shared links

```http
GET /v1/conversations/:conversationId/shared-links?limit=20
```

Every message response now includes `links: string[]`. The shared-links list
contains messages whose current text or caption contains at least one extracted
link. Flatten each item's `links` to build the list and retain its message ID.

Extraction recognizes explicit HTTP(S) URLs, keeps at most 20 distinct links
per message in appearance order, and excludes tokens longer than 2,048
characters. It handles surrounding punctuation and balanced URL parentheses.
It is best-effort plain-text extraction: bare domains, Markdown labels,
credential-bearing URLs, IPv6 literals and non-ASCII hostnames are not a full
supported URL grammar. Use percent encoding/punycode where needed. No network
requests, titles, thumbnails or link previews are generated. The client should
validate the HTTP(S) scheme before opening a link and treat destinations as
untrusted user content.

The database extracts links on send and text edits, and clears them on message
deletion. The migration backfills existing undeleted messages, so students do
not need to resend old links. `message.created`, `message.updated` and
`message.deleted` include the current `links` array through the existing message
payload; use message revisions to reconcile changes as usual.

## Private starred messages

Use `PUT` or `DELETE` on the message's `/star` route with no request body. Both
are idempotent. Starring again keeps the original `starredAt` timestamp.

```json
{
  "conversationId": "00000000-0000-4000-8000-000000002800",
  "messageId": "00000000-0000-4000-8000-000000002803",
  "starred": true,
  "starredAt": "2026-10-28T12:00:00.000Z"
}
```

Unstarring returns `starred: false` and `starredAt: null`. Read `/star` when you
need the state of an individual visible message. The `starred-messages` list
contains only the caller's stars and is ordered by message creation time,
newest first. It returns current message content, including edits.

Stars never appear in another user's responses or in conversation-wide socket
events. Refetch the private list on screen focus to synchronize your own
devices. Conversation favourites continue to use `/favorite`; they are
independent of message stars.

## Pagination and access rules

All three collections use the same history envelope:

```json
{
  "items": [],
  "pageInfo": { "nextCursor": null, "hasNextPage": false }
}
```

`limit` defaults to 50, accepts 1–100, and orders by message creation time then
message ID descending. Pass the returned `nextCursor` unchanged as the `cursor`
query parameter, URL-encoded. Keep the same user, conversation, collection and
media kind. Cursors from history, search or another collection cannot be reused;
they return `400 MESSAGE_CURSOR_INVALID`. When a filter changes, start a new
page sequence. Pages are current views, so refetch from the first page after
local mutations and deduplicate appended messages by ID.

Collections exclude deleted messages and messages at/before your clear-history
boundary. Clear chat or delete-chat-for-me hides those messages from your
gallery, links and stars without changing the other participant's history.
Removed group members cannot read these lists. Stars on hidden messages cannot
be read or changed; those operations return `404 MESSAGE_NOT_FOUND`.

As with ordinary history, blocking someone does not erase already visible
messages or your private stars. Profile access is stricter and rejects blocked
pairs. Existing public Cloudinary URLs are not revoked by clearing/deleting a
message. Invalid authentication returns 401, invalid parameters return 400,
and inaccessible collection reads return `404 CONVERSATION_NOT_FOUND`.
Responses carry `Cache-Control: no-store`.

## Suggested mobile integration order

1. Add bio and the two privacy switches to your own profile settings; load their
   saved values from `/me` and patch only fields the user changed.
2. Open contact details using the participant-profile endpoint. Hide unavailable
   phone/last-seen values and clear stale data when the participant changes.
3. Build a paginated media tab, flattening attachment arrays while retaining
   message and media IDs. Add the media-kind filter.
4. Build a links tab from the paginated `shared-links` messages.
5. Add Star/Unstar to message actions, then build the chat's private starred list.
   Roll back optimistic UI if the request fails.
6. Verify with two accounts: opt out, block, edit/delete a linked message, clear
   one account's history and remove a group member. Reopen the screens after
   restarting the app; never use a device-wide cache across accounts.

## Deployment and verification

Apply `20261028120000_add_chat_details` before running the new API build. It adds
profile fields, message stars, indexed link storage, extraction functions and a
trigger. The link backfill and index creation touch existing messages; measure
migration duration on a staging copy before deploying a large production
history. Existing records default to private phone/last-seen sharing. No new
environment variables or Cloudinary presets are required.

Also apply `20261028140000_add_group_description`, which adds the nullable group
description column. Deploy all pending migrations before the updated API.

```bash
npm run security:check
npm run prisma:deploy --workspace @chateo/api
npm run build
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

Run database tests against a dedicated migrated test database, never the live
service. `DATABASE_URL_INTEGRATION` must name a database ending in `_integration`
or a schema beginning with `chateo_integration`:

```bash
DATABASE_URL_INTEGRATION='postgresql://.../chateo_integration' npm run test:integration
```

The added tests cover profile opt-in/block rules, durable monotonic timestamps,
private/idempotent stars, cleared/deleted history, media-kind filtering,
pagination, link edits and punctuation, HTTP authentication, parameter
validation, cursor scope and Swagger contracts.
