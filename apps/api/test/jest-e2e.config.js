/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testEnvironment: 'node',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  watchman: false,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
