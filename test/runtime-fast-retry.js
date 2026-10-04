import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = pathToFileURL(path.resolve(process.argv[2])).href;
const {lifeCycle, options, resource} = await import(entry);
let requests = 0;
let status = 503;
let retryAfter;
const server = createServer((_request, response) => {
  response.setHeader('Connection', 'close');
  if (++requests === 1) {
    response.statusCode = status;
    if (retryAfter !== undefined) response.setHeader('Retry-After', retryAfter);
    response.end('retry');
  } else {
    response.end('recovered');
  }
});
const deadline = setTimeout(() => { throw new Error('Fast retry checks timed out'); }, 20000);
deadline.unref();
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/retry.bin`;
  for (const header of [undefined, '0', new Date(Date.now() - 1000).toUTCString()]) {
    requests = 0;
    status = header === undefined ? 503 : 429;
    retryAfter = header;
    const delays = [];
    const config = options.defaultDownloadOptions({...lifeCycle.defaultLifeCycle(),
      localRoot: process.cwd(), req: {timeout: {request: 5000}, retry: {
        limit: 1,
        calculateDelay: retry => {
          const random = Math.random;
          try {
            Math.random = () => 0;
            const delay = options.calculateFastDelay(retry);
            assert.equal(delay, 1, 'Eligible immediate retries must not be cancelled');
            delays.push(delay);
            return delay;
          } finally { Math.random = random; }
        }
      }}});
    const res = {...resource.createResource({type: resource.ResourceType.Binary,
      depth: 0, url, refUrl: url, localRoot: process.cwd()}), downloadStartTimestamp: Date.now()};
    const result = await lifeCycle.requestForResource(res, config.req, config);
    assert.equal(result.body.toString(), 'recovered');
    assert.equal(requests, 2);
    assert.deepEqual(delays, [1], 'Got must receive a positive delay to keep the retry');
  }
  console.log(`${process.version}: zero jitter and immediate Retry-After recover through Got`);
} finally {
  clearTimeout(deadline);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
