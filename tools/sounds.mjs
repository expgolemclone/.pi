import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSamples, SAMPLE_RATE } from './vendor/zzfx.mjs';

export const upstream = {
  repository: 'https://github.com/KilledByAPixel/ZzFX',
  version: '1.4.0',
  commit: 'aab7e2b6b9086746b6e55fab75c75ce03e716c49',
};

// ZzFX positional parameters: volume, randomness, frequency, attack, sustain,
// release, shape, shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime,
// repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay,
// tremolo, filter. Omitted trailing values use the pinned ZzFX defaults.
// Randomness is always zero. This is the only source of the adopted sound.
function woodNote(at, frequency) {
  return [
    { at, parameters: [0.20, 0, frequency, 0.003, 0, 0.22, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.20, 0.045] },
    { at, parameters: [0.035, 0, frequency * 2.5, 0.003, 0, 0.07, 0] },
  ];
}

export const sound = {
  description: 'Rounded ascending three-note wood-like chime',
  notes: [
    ...woodNote(0, 523.251131),
    ...woodNote(0.09, 659.255114),
    ...woodNote(0.18, 783.990872),
  ],
};

export function render() {
  const notes = sound.notes.map(({ at, parameters }) => {
    assert.equal(parameters[1], 0, 'Frequency randomness must be disabled');
    assert.ok(at >= 0 && Number.isFinite(at));
    return { offset: Math.round(at * SAMPLE_RATE), samples: buildSamples(...parameters) };
  });
  const length = Math.max(...notes.map(({ offset, samples }) => offset + samples.length));
  const output = new Float32Array(length);
  for (const { offset, samples } of notes) {
    samples.forEach((value, i) => { output[offset + i] += value; });
  }
  return output;
}

export function encodeWav(samples) {
  assert.ok(samples.length > 0, 'No audio samples');
  const dataBytes = samples.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32); // block alignment = channels * bytes/sample
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  samples.forEach((value, i) => {
    assert.ok(Number.isFinite(value) && Math.abs(value) < 1, 'Invalid or clipping sample');
    wav.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2);
  });
  return wav;
}

// Validate the encoded file, not just the floating-point input.
export function inspectWav(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt32LE(28), SAMPLE_RATE * 2);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.equal((wav.length - 44) % 2, 0);
  const count = (wav.length - 44) / 2;
  assert.ok(count > 0);
  let peak = 0, squared = 0, clipped = 0, sum = 0;
  for (let i = 0; i < count; i++) {
    const pcm = wav.readInt16LE(44 + i * 2);
    const value = pcm / 32768;
    peak = Math.max(peak, Math.abs(value));
    squared += value * value;
    sum += value;
    if (pcm === -32768 || pcm === 32767) clipped++;
  }
  return {
    sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, samples: count,
    durationSeconds: count / SAMPLE_RATE, peak, peakDbfs: 20 * Math.log10(peak),
    rms: Math.sqrt(squared / count), dcOffset: sum / count, clippedSamples: clipped,
    firstSample: wav.readInt16LE(44), lastSample: wav.readInt16LE(wav.length - 2),
  };
}

export async function generate(outputDirectory) {
  const wav = encodeWav(render());
  const metrics = inspectWav(wav);
  assert.equal(metrics.clippedSamples, 0);
  assert.ok(metrics.durationSeconds >= 0.2 && metrics.durationSeconds <= 0.5);
  assert.ok(metrics.peak > 0.05 && metrics.peak <= 0.35);
  assert.ok(Math.abs(metrics.dcOffset) < 0.001);
  assert.equal(metrics.firstSample, 0);
  assert.ok(Math.abs(metrics.lastSample) <= 8);
  const report = { file: 'ready.wav', description: sound.description, ...metrics };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, report.file), wav);
  await writeFile(join(outputDirectory, 'validation.json'), JSON.stringify({ upstream, report }, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const directory = process.argv[2] ? resolve(process.argv[2]) : join(root, 'agent/sounds');
  const report = await generate(directory);
  console.log(directory);
  console.table([{
    file: report.file, seconds: report.durationSeconds.toFixed(3),
    peakDbfs: report.peakDbfs.toFixed(2), rms: report.rms.toFixed(4),
    clippedSamples: report.clippedSamples,
  }]);
}
