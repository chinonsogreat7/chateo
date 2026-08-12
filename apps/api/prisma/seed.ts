import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const demoUsers = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    phoneNumber: '+12025550101',
    displayName: 'Ada Okafor',
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    phoneNumber: '+12025550102',
    displayName: 'Tunde Bello',
  },
  {
    id: '00000000-0000-4000-8000-000000000103',
    phoneNumber: '+12025550103',
    displayName: 'Maya Chen',
  },
] as const;

async function seed(): Promise<void> {
  if (
    process.env.ALLOW_DEMO_SEED !== 'true' ||
    process.env.NODE_ENV === 'production'
  ) {
    throw new Error(
      'Demo seeding is disabled. Use ALLOW_DEMO_SEED=true only in a non-production classroom environment.',
    );
  }

  const now = new Date();
  await prisma.$transaction(
    demoUsers.map((user) =>
      prisma.user.upsert({
        where: { phoneNumber: user.phoneNumber },
        create: {
          ...user,
          phoneVerifiedAt: now,
          profileCompletedAt: now,
        },
        update: {
          displayName: user.displayName,
          profileCompletedAt: now,
        },
      }),
    ),
  );
}

seed()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Seeding failed.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
