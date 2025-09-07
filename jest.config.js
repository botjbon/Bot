module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/test/**/*.test.ts',
    '**/test/**/*.test.js',
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.test.js',
  ],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
};