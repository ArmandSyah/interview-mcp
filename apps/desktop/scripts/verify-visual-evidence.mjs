import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

// Read actual GIF blocks rather than trusting the capture manifest's duration.
function inspectGif(data) {
  assert.match(data.toString('ascii', 0, 6), /^GIF8[79]a$/, 'Expected a GIF header');
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  let offset = 13;
  if (data[10] & 128) offset += 3 * 2 ** ((data[10] & 7) + 1);
  let durationMs = 0;
  let frames = 0;
  let delayMs = 0;
  const skipBlocks = () => {
    while (data[offset]) {
      offset += data[offset] + 1;
      assert(offset < data.length, 'Truncated GIF data');
    }
    offset++;
  };
  while (offset < data.length) {
    const marker = data[offset++];
    if (marker === 0x3b) return { width, height, frames, durationMs };
    if (marker === 0x21) {
      const extension = data[offset++];
      if (extension === 0xf9) {
        assert.equal(data[offset], 4, 'Invalid GIF timing block');
        delayMs = data.readUInt16LE(offset + 2) * 10;
      }
      skipBlocks();
    } else if (marker === 0x2c) {
      const packed = data[offset + 8];
      offset += 9;
      if (packed & 128) offset += 3 * 2 ** ((packed & 7) + 1);
      offset++; // LZW code size.
      skipBlocks();
      frames++;
      durationMs += delayMs;
      delayMs = 0;
    } else assert.fail(`Unexpected GIF block ${marker} at ${offset - 1}`);
  }
  assert.fail('Missing GIF trailer');
}

async function manifests(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await manifests(path)));
    else if (entry.name === 'manifest.json') files.push(path);
  }
  return files;
}

const root = resolve(process.argv[2] || 'test-results-evidence');
const results = JSON.parse(await readFile(join(root, 'results.json'), 'utf8'));
assert.equal(results.stats.unexpected, 0, 'Evidence tests failed');
assert.equal(results.stats.flaky, 0, 'Evidence tests required retries');
assert(results.stats.expected > 0, 'No evidence tests passed');
const records = [];
for (const file of await manifests(root)) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(manifest.status, 'passed', `${file}: capture did not finish`);
  assert(manifest.steps.length > 0, `${file}: no recorded actions`);
  assert(manifest.beforeActionMs >= 1000, `${file}: action preview is too short`);
  assert(manifest.resultHoldMs >= 3000, `${file}: result hold is too short`);
  const screenshots = [];
  for (const step of manifest.steps) {
    assert.equal(step.status, 'passed', `${manifest.name}: ${step.title}`);
    assert(step.expected, `${manifest.name}: missing expected result`);
    assert(step.endedMs - step.verifiedMs >= 3000, `${step.title}: result was not held`);
    const screenshot = await readFile(join(dirname(file), step.screenshot));
    assert.equal(
      screenshot.subarray(0, 8).toString('hex'),
      '89504e470d0a1a0a',
      `${step.title}: invalid PNG`,
    );
    screenshots.push({
      file: step.screenshot,
      sha256: createHash('sha256').update(screenshot).digest('hex'),
    });
  }
  const gifFile = join(dirname(file), `${manifest.name}.gif`);
  const gif = await readFile(gifFile);
  const actual = inspectGif(gif);
  assert(actual.frames > 1, `${manifest.name}: GIF is not animated`);
  assert(actual.width >= 1280 && actual.height >= 700, `${manifest.name}: capture is too small`);
  assert(
    Math.abs(actual.durationMs - manifest.durationMs) <= 1500,
    `${manifest.name}: playback does not match elapsed time`,
  );
  records.push({
    name: manifest.name,
    revision: manifest.revision,
    dirty: manifest.dirty,
    steps: manifest.steps.length,
    ...actual,
    bytes: gif.length,
    gif: relative(root, gifFile),
    sha256: createHash('sha256').update(gif).digest('hex'),
    screenshots,
  });
}
assert(records.length > 0, 'No capture manifests found');
assert(records.length >= results.stats.expected, 'A passed test has no capture manifest');
await writeFile(
  join(root, 'verified-evidence.json'),
  JSON.stringify({ tests: results.stats.expected, records }, null, 2),
);
console.log(
  JSON.stringify(
    {
      tests: results.stats.expected,
      journeys: records.length,
      screenshots: records.reduce((n, item) => n + item.steps, 0),
      recordings: records.map(({ name, durationMs, bytes }) => ({ name, durationMs, bytes })),
    },
    null,
    2,
  ),
);
