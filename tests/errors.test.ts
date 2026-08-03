import { describe, it, expect } from 'vitest';
import { ApiError } from '../src/core/errors.js';

describe('ApiError.retryable', () => {
  const cases: Array<[status: number, expected: boolean]> = [
    [0, true], // network failure / no response
    [408, true], // request timeout — transient, worth retrying
    [429, true], // rate limited
    [500, true], // server error
    [503, true], // service unavailable
    [501, false], // not implemented — permanent, retrying can't help
    [505, false], // http version not supported — permanent
    [400, false], // bad request — caller mistake
    [401, false], // unauthorized — caller mistake
    [404, false], // not found — caller mistake
  ];

  it.each(cases)('status %i -> retryable %s', (status, expected) => {
    const err = new ApiError('boom', status, 'body');
    expect(err.retryable).toBe(expected);
  });
});
