const databaseUrl = process.env.DATABASE_URL_INTEGRATION;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL_INTEGRATION is required for PostgreSQL integration tests.',
  );
}

const parsed = new URL(databaseUrl);
const databaseName = parsed.pathname.replace(/^\//, '');
const schemaName = parsed.searchParams.get('schema') ?? 'public';
if (
  !databaseName.endsWith('_integration') &&
  !schemaName.startsWith('chateo_integration')
) {
  throw new Error(
    'Integration tests require a dedicated *_integration database or chateo_integration* schema.',
  );
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;
