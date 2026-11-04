/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'node-crypto-browser-shim',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'node:crypto' || id === 'crypto') {
          return '\0node-crypto-shim';
        }
      },
      load(id) {
        if (id === '\0node-crypto-shim') {
          // Provide createHash with pure JS SHA-256 for browser build
          return `
            function sha256(ascii) {
              function rightRotate(value, amount) {
                return (value >>> amount) | (value << (32 - amount));
              }
              var mathPow = Math.pow;
              var maxWord = mathPow(2, 32);
              var lengthProperty = 'length';
              var i, j;
              var result = '';
              var words = [];
              var asciiBitLength = ascii[lengthProperty] * 8;
              var hash = [];
              var k = [];
              var primeCounter = 0;
              var isComposite = {};
              for (var candidate = 2; primeCounter < 64; candidate++) {
                if (!isComposite[candidate]) {
                  for (i = 0; i < 313; i += candidate) {
                    isComposite[i] = candidate;
                  }
                  hash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
                  k[primeCounter++] = (mathPow(candidate, 1/3) * maxWord) | 0;
                }
              }
              hash = hash.slice(0, 8);
              for (i = 0; i < ascii[lengthProperty]; i++) {
                var code = typeof ascii === 'string' ? ascii.charCodeAt(i) : ascii[i];
                words[i >> 2] = (words[i >> 2] || 0) | (code << (24 - (i % 4) * 8));
              }
              words[asciiBitLength >> 5] = (words[asciiBitLength >> 5] || 0) | (0x80 << (24 - (asciiBitLength % 32)));
              var totalWords = (((asciiBitLength + 64) >> 9) << 4) + 16;
              for (i = 0; i < totalWords; i++) {
                if (!words[i]) words[i] = 0;
              }
              words[totalWords - 2] = Math.floor(asciiBitLength / maxWord);
              words[totalWords - 1] = asciiBitLength | 0;
              for (i = 0; i < words[lengthProperty]; i += 16) {
                var w = words.slice(i, i + 16);
                var oldHash = hash.slice(0);
                for (j = 0; j < 64; j++) {
                  if (j >= 16) {
                    var s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
                    var s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
                    w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
                  }
                  var ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
                  var maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
                  var temp1 = (hash[7] + (rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25)) + ch + k[j] + w[j]) | 0;
                  var temp2 = ((rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22)) + maj) | 0;
                  hash = [(temp1 + temp2) | 0, hash[0], hash[1], hash[2], (hash[3] + temp1) | 0, hash[4], hash[5], hash[6]];
                }
                for (j = 0; j < 8; j++) {
                  hash[j] = (hash[j] + oldHash[j]) | 0;
                }
              }
              for (i = 0; i < 8; i++) {
                for (j = 3; j >= 0; j--) {
                  var b = (hash[i] >> (8 * j)) & 255;
                  result += (b < 16 ? '0' : '') + b.toString(16);
                }
              }
              return result;
            }

            export function createHash(algorithm) {
              var buffers = [];
              return {
                update: function(data) {
                  if (typeof data === 'string') {
                    buffers.push(new TextEncoder().encode(data));
                  } else if (data instanceof Uint8Array) {
                    buffers.push(data);
                  } else if (data instanceof ArrayBuffer) {
                    buffers.push(new Uint8Array(data));
                  }
                  return this;
                },
                digest: function(encoding) {
                  var totalLen = buffers.reduce(function(acc, b) { return acc + b.length; }, 0);
                  var merged = new Uint8Array(totalLen);
                  var offset = 0;
                  for (var i = 0; i < buffers.length; i++) {
                    merged.set(buffers[i], offset);
                    offset += buffers[i].length;
                  }
                  return sha256(merged);
                }
              };
            }
            export default { createHash };
          `;
        }
      },
    },
  ],
  base: './',
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
  },
});

