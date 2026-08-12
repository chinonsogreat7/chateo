import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const databaseUrl = process.env.DATABASE_URL;
const sharedConfig = {
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
};

export default databaseUrl
  ? defineConfig({
      ...sharedConfig,
      engine: 'classic',
      datasource: { url: databaseUrl },
    })
  : defineConfig(sharedConfig);
