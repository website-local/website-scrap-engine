import {expect, test} from '@jest/globals';
import {orderUrlSearch, simpleHashString} from '../src/util.js';

test.each([
  ['?z=last&a=one&a=two&b=x=y', '?a=one&a=two&b=x=y&z=last'],
  ['?b=two+words&a=%2B&a=%20', '?a=%2B&a=%20&b=two+words'],
  ['a&b=&a=', '?a=&a=&b='],
  ['?=left&==right&z=', '?==right==right&=left=left&z='],
  ['&&', '?=&=&='],
  ['', '?='],
  ['?', '?=']
])('query ordering preserves values and duplicate order for %s', (input, expected) => {
  expect(orderUrlSearch(input)).toBe(expected);
});

test.each([
  ['', '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU'],
  ['abc', 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0']
])('query filename hashing keeps its URL-safe SHA-256 format for %s', (input, expected) => {
  expect(simpleHashString(input)).toBe(expected);
});
