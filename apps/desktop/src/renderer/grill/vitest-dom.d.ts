/**
 * Type declarations for @testing-library/jest-dom matchers in vitest.
 */

import type matchers from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T = unknown> extends matchers.TestingLibraryMatchers<
    typeof expect.stringContaining,
    T
  > {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends matchers.TestingLibraryMatchers<
    typeof expect.stringContaining,
    unknown
  > {}
}
