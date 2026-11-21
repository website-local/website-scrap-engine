import {describe, expect, jest, test} from '@jest/globals';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

class MockHTTPError extends Error {
  response: {statusCode: number};
  constructor(statusCode: number) {
    super(`Response code ${statusCode}`);
    this.name = 'HTTPError';
    this.response = {statusCode};
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGot = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('got', () => {
  const mod = {
    default: mockGot,
    HTTPError: MockHTTPError,
    TimeoutError: class TimeoutError extends Error {
      event?: string;
    },
  };
  return mod;
});

jest.mock('log4js', () => ({
  configure: jest.fn(),
  getLogger: jest.fn().mockReturnValue({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const {requestForResource} = await import(
  '../../src/life-cycle/download-resource.js'
);

function makeResource(): Resource & {downloadStartTimestamp: number} {
  const res = createResource({
    type: ResourceType.Html,
    depth: 1,
    url: 'https://example.com/page',
    refUrl: 'https://example.com/',
    localRoot: '/test/root',
    encoding: 'utf8'
  });
  res.downloadStartTimestamp = Date.now();
  return res as Resource & {downloadStartTimestamp: number};
}

describe('requestForResource 304 handling', () => {
  test('returns undefined on 304 HTTPError', async () => {
    mockGot.mockRejectedValueOnce(new MockHTTPError(304));

    const res = makeResource();
    const result = await requestForResource(res, {});
    expect(result).toBeUndefined();
  });

  test('re-throws non-304 HTTPError', async () => {
    mockGot.mockRejectedValueOnce(new MockHTTPError(500));

    const res = makeResource();
    await expect(requestForResource(res, {})).rejects.toThrow('Response code 500');
  });

  test('re-throws non-HTTPError errors', async () => {
    mockGot.mockRejectedValueOnce(new Error('network failure'));

    const res = makeResource();
    await expect(requestForResource(res, {})).rejects.toThrow('network failure');
  });
});
