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
const {withHtmlParser, loadHtml} = await import(entry.href);
const {prepareHtmlParser} = await import(new URL('./cheerio.js', entry).href);
const options = module => ({htmlParser: 'grovedom', grovedom: {module}});

async function checkAliases(aliases) {
  // Preparation and synchronous first load must agree across concurrent scopes.
  await Promise.all([
    withHtmlParser(options(aliases[0]), async () => {
      await prepareHtmlParser(options(aliases[0]));
      assert.ok(loadHtml('<p>asynchronous preparation</p>').html());
    }),
    withHtmlParser(options(aliases[1]), () => {
      assert.ok(loadHtml('<p>synchronous load</p>').html());
    })
  ]);

  for (let index = 0; index < aliases.length; index++) {
    const outer = options(aliases[index]);
    const inner = options(aliases[(index + 1) % aliases.length]);
    let child;
    await withHtmlParser(outer, async () => {
      await withHtmlParser(inner, async () => {
        await prepareHtmlParser(inner);
        child = loadHtml('<p>nested alias</p>');
      });
      assert.ok(child.html().includes('nested alias'));
    });
    assert.throws(() => child.html(), /disposed/i);
    for (const key of ['poolSize', 'poolMaxBytes']) {
      assert.throws(() => withHtmlParser({...outer, grovedom: {...outer.grovedom, [key]: 0}}, () => {
        assert.fail('a conflicting alias must not enter its callback');
      }), /pool options must agree/);
    }
  }
}

await checkAliases(aliases);

// A package exposing only a require condition exercises the loader fallback.
// Keep this fixture next to the tested entry so that its package lookup finds it.
const lookup = path.join(path.dirname(fileURLToPath(entry)), 'node_modules');
let createdLookup = false;
try { await fs.mkdir(lookup); createdLookup = true; }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const fixture = await fs.mkdtemp(path.join(lookup, 'wse-parser-alias-'));
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
console.log('HTML parser aliases: shared initialization, nested ownership, pool conflicts and CommonJS exports passed');
