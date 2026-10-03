import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { candidates, render, encodeWav, inspectWav, generate, upstream } from '../tools/sounds.mjs';
import { buildSamples } from '../tools/vendor/zzfx.mjs';

// Importing these modules in plain Node already verifies that no AudioContext,
// browser, or audio device is required.
test('pinned ZzFX generates reproducible samples without an audio device', () => {
  assert.equal(upstream.version, '1.4.0');
  assert.match(upstream.commit, /^[a-f0-9]{40}$/);
  assert.equal(typeof globalThis.AudioContext, 'undefined');
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    const samples = render(candidate);
    assert.deepEqual(render(candidate), samples);
    const metrics = inspectWav(encodeWav(samples));
    assert.ok(metrics.durationSeconds >= 0.2 && metrics.durationSeconds <= 0.5);
    assert.ok(metrics.peak > 0.05 && metrics.peak <= 0.35);
    assert.ok(metrics.rms > 0.01);
    assert.equal(metrics.clippedSamples, 0);
    assert.ok(Math.abs(metrics.dcOffset) < 0.001);
    assert.equal(metrics.firstSample, 0);
    assert.ok(Math.abs(metrics.lastSample) <= 8);
  }
  assert.ok(buildSamples(0.2, 0, 440).length > 0);
});

test('PCM writer rejects clipping and non-finite samples instead of hiding them', () => {
  for (const value of [-1, 1, -1.1, 1.1, NaN, Infinity, -Infinity]) {
    assert.throws(() => encodeWav([value]), /Invalid or clipping sample/);
  }
  assert.throws(() => encodeWav([]), /No audio samples/);
  const wav = encodeWav([0, -0.5, 0.5]);
  assert.equal(wav.readInt16LE(46), -16384);
  assert.equal(wav.readInt16LE(48), 16384);
  wav.writeUInt16LE(4, 32);
  assert.throws(() => inspectWav(wav));
});

test('candidate generation writes reproducible WAVs and validates files on disk', async (t) => {
  const parent = 'C:/dev/tmp';
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'pi-sounds-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await generate(directory);
  const first = await Promise.all(report.map(({ file }) => readFile(join(directory, file))));
  assert.deepEqual(await generate(directory), report);
  for (const [i, item] of report.entries()) {
    const wav = await readFile(join(directory, item.file));
    assert.deepEqual(wav, first[i]);
    const { file, description, ...metrics } = item;
    assert.deepEqual(inspectWav(wav), metrics);
  }
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8')), { upstream, report });
});
