export const MAX_VIDEO_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_DURATION_MS = 300_000;
export const MAX_VIDEO_DIMENSION = 1920;

export const VIDEO_FORMAT_BY_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
} as const;

export const DOCUMENT_FORMAT_BY_MIME = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
} as const;

export function videoFormat(mime: string): string | null {
  return (
    VIDEO_FORMAT_BY_MIME[mime as keyof typeof VIDEO_FORMAT_BY_MIME] ?? null
  );
}
export function documentFormat(mime: string): string | null {
  return (
    DOCUMENT_FORMAT_BY_MIME[mime as keyof typeof DOCUMENT_FORMAT_BY_MIME] ??
    null
  );
}
export function mediaType(
  mime: string,
): 'image' | 'audio' | 'video' | 'document' {
  if (videoFormat(mime)) return 'video';
  if (documentFormat(mime)) return 'document';
  return mime.startsWith('audio/') ? 'audio' : 'image';
}

export function safeDocumentFilename(
  filename: string | null,
  mediaId: string,
  format: string,
): string {
  // Strip control characters and bidirectional overrides from untrusted display names.
  // eslint-disable-next-line no-control-regex
  const unsafeCharacters = /[\\/\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
  const stem = (filename ?? 'document')
    .replace(/\.[^.]*$/, '')
    .replace(unsafeCharacters, '_')
    .trim()
    .slice(0, 200);
  return `${stem || mediaId}.${format}`;
}
