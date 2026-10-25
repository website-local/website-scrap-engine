import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])) :
  new URL('../lib/index.js', import.meta.url);
const parserPath = process.argv[3] ? path.resolve(process.argv[3]) :
  fileURLToPath(new URL('./grovedom-fixture.js', import.meta.url));
const parserUrl = pathToFileURL(parserPath).href;
const relative = './' + path.relative(path.dirname(fileURLToPath(entry)), parserPath).split(path.sep).join('/');
const aliases = process.argv[3] ? ['grovedom', parserUrl, parserPath, relative] :
  [relative, parserUrl, parserPath];
aliases.push(parserUrl + '?alias=1', parserUrl + '#alias');
if (path.extname(parserPath) === '.js') aliases.push(parserPath.slice(0, -3));
if (process.argv[3]) assert.equal(createRequire(entry).resolve('grovedom'), parserPath);
const {loadHtml} = await import(entry.href);
const {prepareHtmlParser} = await import(new URL('./cheerio.js', entry).href);
const options = module => ({htmlParser: 'grovedom', grovedom: {module}});

async function checkAliases(aliases) {
  // Preparation and synchronous first load must use the same module instance.
  const preparing = Promise.resolve(prepareHtmlParser(options(aliases[0])));
  const immediate = loadHtml('<p>synchronous load</p>', undefined, undefined, options(aliases[1]));
  try {
    assert.ok(immediate.html());
    await preparing;
  } finally { immediate.dispose(); }

  for (let index = 0; index < aliases.length; index++) {
    const outer = options(aliases[index]);
    const inner = options(aliases[(index + 1) % aliases.length]);
    const parent = loadHtml('<p>outer alias</p>', undefined, undefined, outer);
    await prepareHtmlParser(inner);
    const child = loadHtml('<p>nested alias</p>', undefined, undefined, inner);
    parent.dispose();
    try {
      assert.throws(() => parent.html(), /disposed/i);
      assert.ok(child.html().includes('nested alias'));
      const nested = child.load('<p>document load</p>');
      try { assert.ok(nested.html().includes('document load')); }
      finally { nested.dispose(); }
    } finally { child.dispose(); }
    assert.throws(() => child.html(), /disposed/i);
    for (const key of ['poolSize', 'poolMaxBytes']) {
      assert.throws(() => loadHtml('<p>conflict</p>', undefined, undefined,
        {...outer, grovedom: {...outer.grovedom, [key]: 0}}), /pool options must agree/);
    }
  }
}

await checkAliases(aliases);

// A reserved object-property name must still resolve as a package, and a
// require-only export exercises the synchronous loader fallback.
// Keep this fixture next to the tested entry so that its package lookup finds it.
const lookup = path.join(path.dirname(fileURLToPath(entry)), 'node_modules');
let createdLookup = false;
try { await fs.mkdir(lookup); createdLookup = true; }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const fixture = path.join(lookup, 'constructor');
await fs.mkdir(fixture);
try {
  const name = path.basename(fixture), file = path.join(fixture, 'index.cjs');
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({name, exports: {require: './index.cjs'}}));
  await fs.copyFile(new URL('./grovedom-fixture.cjs', import.meta.url), file);
  await checkAliases([name, pathToFileURL(file).href, file]);
} finally {
  await fs.rm(fixture, {recursive: true, force: true});
  if (createdLookup) {
    await fs.rmdir(lookup).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
  }
}
console.log('HTML parser aliases: shared initialization, explicit ownership, pool conflicts, reserved names and CommonJS exports passed');
