import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

// Synthetic data only. Never open the workstation database or credentials.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-stream-benchmark-'));
const payload = 'x'.repeat(2200);
const rows = Array.from({ length: 40000 }, (_, id) => ({ id, payload }));
const results = [];
try {
  for (const mode of ['row', 'chunk', 'row', 'chunk']) {
    const highWaterMark = 1048576;
    const target = path.join(directory, `sample-${results.length}.json`);
    const stream = fs.createWriteStream(target, { highWaterMark });
    let drains = 0;
    let serialization_ms = 0;
    let drain_ms = 0;
    let writes = 0;
    const write = async value => {
      writes++;
      if (!stream.write(value)) {
        drains++;
        const start = performance.now();
        await once(stream, 'drain');
        drain_ms += performance.now() - start;
      }
    };
    const start = performance.now();
    await write('[');
    let chunk = '';
    for (let i = 0; i < rows.length; i++) {
      const serializeStart = performance.now();
      const value = (i ? ',' : '') + JSON.stringify(rows[i]);
      serialization_ms += performance.now() - serializeStart;
      if (mode === 'row') await write(value);
      else {
        chunk += value;
        if (chunk.length >= 262144) { await write(chunk); chunk = ''; }
      }
    }
    if (chunk) await write(chunk);
    await write(']');
    stream.end();
    await once(stream, 'close');
    const elapsed_ms = performance.now() - start;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    results.push({ mode, highWaterMark, elapsed_ms, serialization_ms, drain_ms, writes, drains, bytes: fs.statSync(target).size, sha256: hash.digest('hex') });
    fs.unlinkSync(target);
  }
  console.log(JSON.stringify({ synthetic: true, row_count: rows.length, results }, null, 2));
} finally {
  // Only our newly-created, now-empty temporary directory. Never recursive.
  fs.rmdirSync(directory);
}
