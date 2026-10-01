import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:https';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const entry = pathToFileURL(path.resolve(process.argv[2])).href;
const {lifeCycle, options, resource} = await import(entry);
const server = createServer({
  key: await readFile(new URL('fixtures/native-http-key.pem', import.meta.url)),
  cert: await readFile(new URL('fixtures/native-http-cert.pem', import.meta.url))
}, (_request, response) => response.end('verified TLS'));
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `https://127.0.0.1:${server.address().port}/native`;
  const config = options.defaultDownloadOptions({...lifeCycle.defaultLifeCycle(),
    httpTransport: 'native', localRoot: process.cwd()});
  const res = {...resource.createResource({type: resource.ResourceType.Binary,
    depth: 0, url, refUrl: url, localRoot: process.cwd()}), downloadStartTimestamp: Date.now()};
  const result = await lifeCycle.requestForResource(res, config.req, config);
  assert.equal(result.body.toString(), 'verified TLS');
  assert.equal(res.meta.httpTransport, 'native');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
