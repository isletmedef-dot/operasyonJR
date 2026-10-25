'use strict';

module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    testTimeout: 30000,
    verbose: true,
    // The app keeps a module-level sqlite3 handle; each suite closes it in afterAll,
    // then Jest's workers can exit on their own.
    forceExit: false,
};
