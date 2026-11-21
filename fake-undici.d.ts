/* eslint-disable */
// Local types for the root npm skip-dependency override; consumers do not
// inherit that override. The engine only uses Cheerio's document loader.
// On Cheerio upgrades, check that its root import still works with the alias
// and run check-consumer.mjs against Undici declarations, not this any shim.
declare var nop: any;
export declare type Dispatcher = any;
export declare namespace Dispatcher {
  type RequestOptions<T> = any;
}
export default nop;
