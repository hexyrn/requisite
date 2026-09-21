/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['<rootDir>/../jest.setup.js'],
  moduleNameMapper: {
    '^@hexyrn/shared-types$': '<rootDir>/../../../packages/shared-types/src/index.ts',
  },
};
