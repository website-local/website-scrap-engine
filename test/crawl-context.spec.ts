import {expect, test} from '@jest/globals';
import {throwIfCancelled, withCrawlContext} from '../src/crawl-context.js';
import {createDefaultLogger} from '../src/logger/default-logger.js';

test('cancellation honors an independent context signal', () => {
  const primary = new AbortController();
  const context = new AbortController();
  context.abort(new Error('context cancelled'));
  withCrawlContext({signal: context.signal, logger: createDefaultLogger()}, () => {
    expect(() => throwIfCancelled(primary.signal)).toThrow('context cancelled');
  });
});

test('the explicit signal retains precedence when both signals are cancelled', () => {
  const primary = new AbortController();
  const context = new AbortController();
  primary.abort(new Error('primary cancelled'));
  context.abort(new Error('context cancelled'));
  withCrawlContext({signal: context.signal, logger: createDefaultLogger()}, () => {
    expect(() => throwIfCancelled(primary.signal)).toThrow('primary cancelled');
  });
});

test('shared signals and callers outside a crawl still observe cancellation', () => {
  const controller = new AbortController();
  expect(() => throwIfCancelled()).not.toThrow();
  expect(() => throwIfCancelled(controller.signal)).not.toThrow();
  withCrawlContext({signal: controller.signal, logger: createDefaultLogger()}, () => {
    expect(() => throwIfCancelled(controller.signal)).not.toThrow();
    controller.abort(new Error('shared cancelled'));
    expect(() => throwIfCancelled(controller.signal)).toThrow('shared cancelled');
    expect(() => throwIfCancelled()).toThrow('shared cancelled');
  });
  expect(() => throwIfCancelled(controller.signal)).toThrow('shared cancelled');
});
