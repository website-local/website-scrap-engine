// Use with node --import and benchmark-crawl.mjs; counts parent-side calls only.
import {promises as fs} from 'node:fs';
const counts = {};
for (const name of ['mkdir', 'lstat', 'realpath', 'mkdtemp', 'rename', 'rm']) {
  const original = fs[name];
  fs[name] = async function (...args) {
    const match = String(args[0]).match(/\/(\d+)-local-SingleThreadDownloader-(-?\d+)\//);
    if (match && match[2] === '0') {
      const key = match[1] + '/' + name;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return original.apply(this, args);
  };
}
process.on('exit', () => process.stderr.write(JSON.stringify({filesystemCalls: counts}) + '\n'));
