// CommonJS lets Jest exercise synchronous loading in its isolated registry.
// The ESM entry is retained for real Node loader and worker regressions.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {createRequire} = require('node:module');
const {load: cheerio} = createRequire(__filename)('cheerio');

/** @type {{initializations: object[], documents: {closed: boolean, disposals: number}[]}} */
const state = exports.state = {initializations: [], documents: []};
exports.init = function init(options) {
  if (state.initializations.length) throw new Error('Already initialized');
  state.initializations.push(options);
};
exports.load = function load(...args) {
  const document = cheerio(...args);
  const html = document.html.bind(document);
  const record = {closed: false, disposals: 0};
  const fail = !!document('[data-dispose-error]').length;
  state.documents.push(record);
  document.html = (...args) => {
    if (record.closed) throw new Error('Disposed document');
    return html(...args);
  };
  document.dispose = () => {
    record.closed = true;
    record.disposals++;
    if (fail) throw new Error('Injected disposal failure');
  };
  return document;
};
