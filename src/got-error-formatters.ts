import {createRequire} from 'node:module';

// Optional preload: import before Got/the engine, or use Node's --import flag.
// is@8 only calls format() on these two private error formatters. Defer their
// native allocation until an assertion fails. The temporary replacement is
// synchronous; restore Intl before returning to the event loop, even on failure.
// On Got/@sindresorhus/is upgrades, recheck those constructor arguments and the
// format-only usage below against test/runtime-got-formatters.js. If upstream
// removes eager formatters, retire this preload; a no-op breaks error messages.
if (Object.getOwnPropertyDescriptor(Intl, 'ListFormat')?.writable) {
  const require = createRequire(import.meta.url);
  const requireFromGot = createRequire(require.resolve('got'));
  const ListFormat = Intl.ListFormat;
  Object.defineProperty(Intl, 'ListFormat', {value: new Proxy(ListFormat, {
    construct(target, args, newTarget) {
      const [locales, options] = args;
      if (locales !== 'en' || options?.style !== 'long' ||
        (options.type !== 'conjunction' && options.type !== 'disjunction')) {
        return Reflect.construct(target, args, newTarget);
      }
      let formatter: Intl.ListFormat | undefined;
      return {
        format(values: Iterable<string>) {
          formatter ??= Reflect.construct(target, args) as Intl.ListFormat;
          return formatter.format(values);
        }
      };
    }
  })});
  try {
    requireFromGot('@sindresorhus/is');
  } catch (error) {
    // Concurrent ESM loading or an asynchronous dependency cannot be preloaded
    // synchronously. Leave those cases to Got's ordinary import instead.
    // Node upgrades must keep the runtime test's concurrent-import, race and
    // async-module cases passing; do not swallow unrelated dependency errors.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ERR_REQUIRE_ESM_RACE_CONDITION' &&
      code !== 'ERR_REQUIRE_ASYNC_MODULE' && code !== 'ERR_REQUIRE_ESM') throw error;
  } finally {
    Object.defineProperty(Intl, 'ListFormat', {value: ListFormat});
  }
}
