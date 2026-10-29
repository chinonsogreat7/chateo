ALTER TABLE "users"
  ADD COLUMN "bio" VARCHAR(160),
  ADD COLUMN "share_phone_number" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "share_last_seen" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "last_seen_at" TIMESTAMPTZ(3);

CREATE TABLE "message_stars" (
  "message_id" UUID NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "starred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("message_id", "user_id")
);
CREATE INDEX "message_stars_user_id_message_id_idx" ON "message_stars"("user_id", "message_id");

ALTER TABLE "messages" ADD COLUMN "links" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- One extractor covers old messages, new sends, edits and SQL imports.
-- Best-effort HTTP(S) tokens only: no previews, redirects or network requests.
CREATE FUNCTION chateo_trim_message_link(token TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE
  closer TEXT;
  opener TEXT;
BEGIN
  LOOP
    token := rtrim(token, '.,!?;:');
    closer := right(token, 1);
    opener := CASE closer WHEN ')' THEN '(' WHEN ']' THEN '[' WHEN '}' THEN '{' ELSE NULL END;
    EXIT WHEN opener IS NULL;
    -- Keep balanced delimiters that are part of a URL (e.g. Wikipedia paths).
    EXIT WHEN length(token) - length(replace(token, closer, '')) <= length(token) - length(replace(token, opener, ''));
    token := left(token, length(token) - 1);
  END LOOP;
  RETURN token;
END;
$fn$;

CREATE FUNCTION chateo_message_links(body TEXT) RETURNS TEXT[]
LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT COALESCE(array_agg(url ORDER BY first_position), ARRAY[]::TEXT[])
  FROM (
    SELECT url, min(position) AS first_position
    FROM (
      SELECT chateo_trim_message_link(match[1]) AS url, position
      FROM regexp_matches(COALESCE(body, ''), 'https?://[^[:space:]<>"''`]+', 'gi')
           WITH ORDINALITY AS found(match, position)
    ) tokens
    WHERE length(url) <= 2048
      AND url ~* '^https?://[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?([/?#]|$)'
    GROUP BY url ORDER BY min(position) LIMIT 20
  ) unique_urls;
$fn$;

CREATE FUNCTION chateo_update_message_links() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.links := CASE WHEN NEW.deleted_at IS NULL THEN chateo_message_links(NEW.text) ELSE ARRAY[]::TEXT[] END;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER messages_extract_links
BEFORE INSERT OR UPDATE OF text, deleted_at ON "messages"
FOR EACH ROW EXECUTE FUNCTION chateo_update_message_links();

UPDATE "messages" SET "links" = chateo_message_links("text")
WHERE "deleted_at" IS NULL AND "text" ~* 'https?://';

CREATE INDEX "messages_shared_links_idx" ON "messages"("conversation_id", "created_at", "id")
WHERE "deleted_at" IS NULL AND NOT ("links" = ARRAY[]::TEXT[]);
CREATE INDEX "messages_shared_media_idx" ON "messages"("conversation_id", "kind", "created_at", "id")
WHERE "deleted_at" IS NULL AND "kind" <> 'TEXT';
