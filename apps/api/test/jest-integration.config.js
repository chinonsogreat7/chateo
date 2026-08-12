/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  setupFiles: ['<rootDir>/test/setup-integration-env.ts'],
  testEnvironment: 'node',
  testRegex: 'test/.*[.]integration-spec[.]ts$',
  testTimeout: 30000,
  watchman: false,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
