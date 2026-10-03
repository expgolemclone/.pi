import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { sound, render, encodeWav, inspectWav, generate, upstream } from '../tools/sounds.mjs';
import { buildSamples } from '../tools/vendor/zzfx.mjs';

// Plain Node import verifies there is no AudioContext or audio-device dependency.
test('pinned ZzFX generates reproducible samples without an audio device', () => {
  assert.equal(upstream.version, '1.4.0');
  assert.match(upstream.commit, /^[a-f0-9]{40}$/);
  assert.equal(typeof globalThis.AudioContext, 'undefined');
  const samples = render();
  assert.deepEqual(render(), samples);
  const metrics = inspectWav(encodeWav(samples));
  assert.ok(metrics.durationSeconds >= 0.2 && metrics.durationSeconds <= 0.5);
  assert.ok(metrics.peak > 0.05 && metrics.peak <= 0.35);
  assert.ok(metrics.rms > 0.01);
  assert.equal(metrics.clippedSamples, 0);
  assert.ok(Math.abs(metrics.dcOffset) < 0.001);
  assert.equal(metrics.firstSample, 0);
  assert.ok(Math.abs(metrics.lastSample) <= 8);
  assert.ok(buildSamples(0.2, 0, 440).length > 0);
});

test('adopted wood chime has three ascending notes with the same two-component timbre', () => {
  assert.equal(sound.notes.length, 6);
  let previousFrequency = 0;
  let previousTime = -1;
  for (let i = 0; i < sound.notes.length; i += 2) {
    const fundamental = sound.notes[i];
    const overtone = sound.notes[i + 1];
    assert.equal(fundamental.at, overtone.at);
    assert.ok(fundamental.at > previousTime);
    assert.ok(fundamental.parameters[2] > previousFrequency);
    const midiNote = [60, 64, 67][i / 2]; // C4, E4, G4, one octave below the original
    assert.ok(Math.abs(fundamental.parameters[2] - 440 * 2 ** ((midiNote - 69) / 12)) < 0.00001);
    assert.equal(overtone.parameters[2], fundamental.parameters[2] * 2.5);
    if (i > 0) {
      for (const component of [0, 1]) {
        const timbre = sound.notes[i + component].parameters.filter((_, index) => index !== 2);
        assert.deepEqual(timbre, sound.notes[component].parameters.filter((_, index) => index !== 2));
      }
    }
    previousTime = fundamental.at;
    previousFrequency = fundamental.parameters[2];
  }
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

test('generation writes only the adopted WAV and its reproducible validation report', async (t) => {
  const parent = 'C:/dev/tmp';
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'pi-sounds-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await generate(directory);
  const first = await readFile(join(directory, report.file));
  assert.deepEqual(await generate(directory), report);
  const wav = await readFile(join(directory, report.file));
  assert.deepEqual(wav, first);
  const { file, description, ...metrics } = report;
  assert.deepEqual(inspectWav(wav), metrics);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8')), { upstream, report });
  assert.deepEqual((await readdir(directory)).sort(), ['ready.wav', 'validation.json']);
});
