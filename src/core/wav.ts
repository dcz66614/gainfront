/**
 * GainFront RIFF PCM16 WAV Decoder and Encoder
 *
 * Implements strict RIFF WAVE PCM16 parsing per PROJECT_BOOK.md §5.1 & §8.2.
 * Enforces 48000 Hz, 1|2 channels, 1.0s-30.0s, and <= 8 MiB boundary.
 */

import { GainFrontError } from './errors.js';
import type { PCM } from './types.js';
import { validatePcm, validatePcmMetadata, validateWavByteLength } from './validate.js';

/**
 * Decodes an in-memory 16-bit uncompressed PCM WAV buffer.
 *
 * Strict validation:
 * - Buffer size: 1.0s to 30.0s audio, max 8 MiB
 * - Container: RIFF + WAVE
 * - Exactly one 'fmt ' chunk and one 'data' chunk
 * - audioFormat = 1 (PCM), bitsPerSample = 16, little endian, blockAlign = channels * 2
 * - sampleRate = 48000 Hz, channels = 1 | 2
 * - Rejects compressed audio, duplicate/missing chunks, corrupted boundaries
 * - Int16 samples mapped to Float64 via sample / 32768
 */
export function decodePcm16Wav(bytes: ArrayBuffer): PCM {
  if (!(bytes instanceof ArrayBuffer)) {
    throw new GainFrontError('UNSUPPORTED_WAV', 'Expected ArrayBuffer for WAV decoding');
  }

  // Validate byte length against 8 MiB limit and positive bounds
  validateWavByteLength(bytes.byteLength);

  if (bytes.byteLength < 12) {
    throw new GainFrontError('UNSUPPORTED_WAV', 'Buffer too small for RIFF WAVE header');
  }

  const view = new DataView(bytes);

  // Check 'RIFF' signature (0x52, 0x49, 0x46, 0x46)
  const r0 = view.getUint8(0);
  const r1 = view.getUint8(1);
  const r2 = view.getUint8(2);
  const r3 = view.getUint8(3);
  if (r0 !== 0x52 || r1 !== 0x49 || r2 !== 0x46 || r3 !== 0x46) {
    throw new GainFrontError('UNSUPPORTED_WAV', 'Missing RIFF signature in container header');
  }

  const riffChunkSize = view.getUint32(4, true);

  // RIFF size must at least hold the 4-byte 'WAVE' signature
  if (riffChunkSize < 4) {
    throw new GainFrontError('UNSUPPORTED_WAV', 'RIFF chunk size too small for WAVE identifier');
  }

  // File must not be truncated
  if (bytes.byteLength < riffChunkSize + 8) {
    throw new GainFrontError(
      'UNSUPPORTED_WAV',
      `Truncated RIFF file: byteLength (${bytes.byteLength}) is less than declared RIFF size (${riffChunkSize + 8})`,
      { byteLength: bytes.byteLength, declaredRiffSize: riffChunkSize + 8 },
    );
  }

  // File must not have trailing garbage beyond declared RIFF size (+ 1 optional pad byte)
  if (bytes.byteLength > riffChunkSize + 8 + 1) {
    throw new GainFrontError(
      'UNSUPPORTED_WAV',
      `Corrupted RIFF file: byteLength (${bytes.byteLength}) exceeds declared RIFF size (${riffChunkSize + 8})`,
      { byteLength: bytes.byteLength, declaredRiffSize: riffChunkSize + 8 },
    );
  }

  // Check 'WAVE' format signature (0x57, 0x41, 0x56, 0x45)
  const w0 = view.getUint8(8);
  const w1 = view.getUint8(9);
  const w2 = view.getUint8(10);
  const w3 = view.getUint8(11);
  if (w0 !== 0x57 || w1 !== 0x41 || w2 !== 0x56 || w3 !== 0x45) {
    throw new GainFrontError('UNSUPPORTED_WAV', 'Missing WAVE format identifier');
  }

  let offset = 12;
  const effectiveEnd = riffChunkSize + 8;

  let fmtChunk: {
    audioFormat: number;
    channels: 1 | 2;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
  } | null = null;

  let dataChunk: {
    offset: number;
    size: number;
  } | null = null;

  while (offset < effectiveEnd) {
    if (offset + 8 > effectiveEnd) {
      throw new GainFrontError('UNSUPPORTED_WAV', `Incomplete chunk header at offset ${offset}`);
    }

    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkDataOffset + chunkSize > effectiveEnd) {
      throw new GainFrontError(
        'UNSUPPORTED_WAV',
        `Chunk "${chunkId}" size (${chunkSize}) overflows file container (${effectiveEnd})`,
        { chunkId, chunkSize, offset, effectiveEnd },
      );
    }

    if (chunkId === 'fmt ') {
      if (fmtChunk !== null) {
        throw new GainFrontError('UNSUPPORTED_WAV', 'Duplicate fmt chunk detected');
      }
      if (chunkSize < 16) {
        throw new GainFrontError('UNSUPPORTED_WAV', `fmt chunk size ${chunkSize} is smaller than required 16 bytes`);
      }

      const audioFormat = view.getUint16(chunkDataOffset, true);
      const channels = view.getUint16(chunkDataOffset + 2, true);
      const sampleRate = view.getUint32(chunkDataOffset + 4, true);
      const byteRate = view.getUint32(chunkDataOffset + 8, true);
      const blockAlign = view.getUint16(chunkDataOffset + 12, true);
      const bitsPerSample = view.getUint16(chunkDataOffset + 14, true);

      if (audioFormat !== 1) {
        throw new GainFrontError(
          'UNSUPPORTED_WAV',
          `Unsupported audio format ${audioFormat}; only uncompressed PCM (format 1) is supported`,
          { audioFormat },
        );
      }
      if (channels !== 1 && channels !== 2) {
        throw new GainFrontError(
          'UNSUPPORTED_WAV',
          `Unsupported channels ${channels}; only mono (1) or stereo (2) supported`,
          { channels },
        );
      }
      if (sampleRate !== 48000) {
        throw new GainFrontError(
          'UNSUPPORTED_WAV',
          `Unsupported sample rate ${sampleRate} Hz; must be 48000 Hz`,
          { sampleRate, expected: 48000 },
        );
      }
      if (bitsPerSample !== 16) {
        throw new GainFrontError(
          'UNSUPPORTED_WAV',
          `Unsupported bits per sample ${bitsPerSample}; only 16-bit PCM is supported`,
          { bitsPerSample, expected: 16 },
        );
      }
      if (blockAlign !== channels * 2) {
        throw new GainFrontError(
          'UNSUPPORTED_WAV',
          `Invalid block align ${blockAlign}; expected ${channels * 2}`,
          { blockAlign, expected: channels * 2 },
        );
      }
      if (byteRate !== sampleRate * blockAlign) {
        throw new GainFrontError(
          'UNSUPPORTED_WAV',
          `Invalid byte rate ${byteRate}; expected ${sampleRate * blockAlign}`,
          { byteRate, expected: sampleRate * blockAlign },
        );
      }

      fmtChunk = {
        audioFormat,
        channels: channels as 1 | 2,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample,
      };
    } else if (chunkId === 'data') {
      if (dataChunk !== null) {
        throw new GainFrontError('UNSUPPORTED_WAV', 'Duplicate data chunk detected');
      }
      dataChunk = {
        offset: chunkDataOffset,
        size: chunkSize,
      };
    } else {
      // Non-critical informational chunks (e.g. LIST, JUNK, bext, id3) are permitted
    }

    // Advance offset with 2-byte word padding per RIFF spec
    const paddedSize = chunkSize + (chunkSize & 1);
    offset = chunkDataOffset + paddedSize;
  }

  if (fmtChunk === null) {
    throw new GainFrontError('UNSUPPORTED_WAV', 'Missing required fmt chunk in WAV file');
  }
  if (dataChunk === null) {
    throw new GainFrontError('UNSUPPORTED_WAV', 'Missing required data chunk in WAV file');
  }

  if (dataChunk.size % fmtChunk.blockAlign !== 0) {
    throw new GainFrontError(
      'UNSUPPORTED_WAV',
      `data chunk size ${dataChunk.size} is not aligned with block align ${fmtChunk.blockAlign}`,
      { dataSize: dataChunk.size, blockAlign: fmtChunk.blockAlign },
    );
  }

  const frames = dataChunk.size / fmtChunk.blockAlign;
  validatePcmMetadata(fmtChunk.sampleRate, fmtChunk.channels, frames);

  const channels = fmtChunk.channels;
  const planar: Float64Array[] = [];

  if (channels === 1) {
    const ch0 = new Float64Array(frames);
    for (let n = 0; n < frames; n++) {
      const raw = view.getInt16(dataChunk.offset + n * 2, true);
      ch0[n] = raw / 32768;
    }
    planar.push(ch0);
  } else {
    const ch0 = new Float64Array(frames);
    const ch1 = new Float64Array(frames);
    for (let n = 0; n < frames; n++) {
      const raw0 = view.getInt16(dataChunk.offset + n * 4, true);
      const raw1 = view.getInt16(dataChunk.offset + n * 4 + 2, true);
      ch0[n] = raw0 / 32768;
      ch1[n] = raw1 / 32768;
    }
    planar.push(ch0, ch1);
  }

  return {
    sampleRate: 48000,
    channels,
    frames,
    planar,
  };
}

/**
 * Encodes a valid PCM structure into an uncompressed RIFF PCM16 ArrayBuffer.
 *
 * Clamps floating-point samples to [-1.0, 1.0] and scales to [-32768, 32767].
 */
export function encodePcm16Wav(pcm: PCM): ArrayBuffer {
  validatePcm(pcm);

  const { sampleRate, channels, frames, planar } = pcm;
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frames * blockAlign;
  const riffChunkSize = 36 + dataSize;
  const totalBytes = 44 + dataSize;

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);

  // 'RIFF' header
  view.setUint8(0, 0x52);
  view.setUint8(1, 0x49);
  view.setUint8(2, 0x46);
  view.setUint8(3, 0x46);
  view.setUint32(4, riffChunkSize, true);

  // 'WAVE' format
  view.setUint8(8, 0x57);
  view.setUint8(9, 0x41);
  view.setUint8(10, 0x56);
  view.setUint8(11, 0x45);

  // 'fmt ' chunk
  view.setUint8(12, 0x66);
  view.setUint8(13, 0x6d);
  view.setUint8(14, 0x74);
  view.setUint8(15, 0x20);
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample = 16

  // 'data' chunk
  view.setUint8(36, 0x64);
  view.setUint8(37, 0x61);
  view.setUint8(38, 0x74);
  view.setUint8(39, 0x61);
  view.setUint32(40, dataSize, true);

  const clampInt16 = (v: number): number => {
    const s = Math.round(v * 32768);
    return Math.max(-32768, Math.min(32767, s));
  };

  let byteOffset = 44;
  if (channels === 1) {
    const ch0 = planar[0];
    for (let n = 0; n < frames; n++) {
      view.setInt16(byteOffset, clampInt16(ch0[n]), true);
      byteOffset += 2;
    }
  } else {
    const ch0 = planar[0];
    const ch1 = planar[1];
    for (let n = 0; n < frames; n++) {
      view.setInt16(byteOffset, clampInt16(ch0[n]), true);
      view.setInt16(byteOffset + 2, clampInt16(ch1[n]), true);
      byteOffset += 4;
    }
  }

  return buffer;
}
