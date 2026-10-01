import type {GenerateSavePathFunc} from './types.js';

// Only the built-in legacy adapter can promise it never reads the default path.
// Keep recognition separate from adapters.ts so the executor need not load HTML parsers.
export const fullSavePathHooks = new WeakSet<GenerateSavePathFunc>();
