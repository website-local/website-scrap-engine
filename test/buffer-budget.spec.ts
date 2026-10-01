import {expect, test} from '@jest/globals';
import {BufferBudget} from '../src/buffer-budget.js';

test('aggregate body reservations reject overflow without consuming capacity', () => {
  const budget = new BufferBudget(10);
  const first = budget.reserve(4);
  const second = budget.reserve(6);
  expect(budget.used).toBe(10);
  expect(() => budget.reserve(1)).toThrow(expect.objectContaining({code: 'ERR_BUFFER_BUDGET',
    limit: 10, actual: 11}));
  expect(() => first.observeBody(5)).toThrow(expect.objectContaining({code: 'ERR_BUFFER_BUDGET'}));
  expect(budget.used).toBe(10);
  second.release();
  first.observeBody(8);
  first.observeBody(3);
  expect(budget.used).toBe(8);
  expect(budget.peak).toBe(10);
  first.release();
  expect(budget.used).toBe(0);
});

test('child ownership transfers at a full budget and survives parent cleanup', () => {
  const budget = new BufferBudget(10);
  const parent = budget.reserve(4);
  parent.reserveChild(6);
  const child = parent.takeChild(6);
  expect(budget.used).toBe(10);
  parent.release();
  expect(budget.used).toBe(6);
  child.observeBody(10);
  child.release();
  expect(budget.used).toBe(0);
});

test('failed child reservation/transfer preserves earlier credits and parent cleanup releases them', () => {
  const budget = new BufferBudget(10);
  const parent = budget.reserve(4);
  parent.reserveChild(3);
  expect(() => parent.reserveChild(4)).toThrow(expect.objectContaining({code: 'ERR_BUFFER_BUDGET'}));
  expect(() => parent.takeChild(4)).toThrow('exceeds reserved');
  expect(budget.used).toBe(7);
  parent.release();
  parent.release();
  expect(budget.used).toBe(0);
  expect(() => parent.observeBody(1)).toThrow('closed');
  expect(() => parent.reserveChild(1)).toThrow('closed');
  expect(() => parent.takeChild(0)).toThrow('closed');
});

test('reservations validate sizes and support exact-limit safe integer accounting', () => {
  const budget = new BufferBudget(Number.MAX_SAFE_INTEGER);
  const reservation = budget.reserve(Number.MAX_SAFE_INTEGER);
  expect(() => budget.reserve(1)).toThrow(expect.objectContaining({code: 'ERR_BUFFER_BUDGET'}));
  reservation.release();
  for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => budget.reserve(size)).toThrow(RangeError);
  }
  expect(budget.used).toBe(0);
});
