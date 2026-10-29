import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateProfileDto } from './dto/update-profile.dto';

describe('profile field validation', () => {
  it('trims a bio and accepts explicit privacy preferences', async () => {
    const input = plainToInstance(UpdateProfileDto, {
      bio: '  Learning React Native  ',
      sharePhoneNumber: true,
      shareLastSeen: false,
    });
    expect(
      await validate(input, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    expect(input).toMatchObject({
      bio: 'Learning React Native',
      sharePhoneNumber: true,
      shareLastSeen: false,
    });
  });

  it.each([
    { bio: 'x'.repeat(161) },
    { bio: null },
    { sharePhoneNumber: 'true' },
    { shareLastSeen: null },
    { displayName: null },
  ])('rejects invalid profile data %j', async (body) => {
    expect(
      (
        await validate(plainToInstance(UpdateProfileDto, body), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length,
    ).toBeGreaterThan(0);
  });

  it('accepts an empty bio to clear it', async () => {
    expect(
      await validate(plainToInstance(UpdateProfileDto, { bio: '' }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toEqual([]);
  });
});
