/**
 * scripts/build-release.mjs
 *
 * Official release bundle & validation script for P010 GainFront (T018).
 * Performs a clean rebuild (npm ci, npm run typecheck, npm test, npm run build),
 * logs complete console output into evidence/validation-logs/T018-release.txt,
 * packages release/source-release.zip and release/dist-release.zip,
 * produces release/SOURCE_MANIFEST.csv and release/SHA256SUMS.txt,
 * and verifies integrity against manifests and checksums.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cwd = path.resolve(__dirname, '..');

// Ensure local .tmp directory is used instead of small /tmp tmpfs
const tmpDir = path.resolve(cwd, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir;

const valLogsDir = path.resolve(cwd, 'evidence/validation-logs');
const releaseDir = path.resolve(cwd, 'release');
const reviewPacksDir = path.resolve(cwd, 'evidence/review-packs');

fs.mkdirSync(valLogsDir, { recursive: true });
fs.mkdirSync(releaseDir, { recursive: true });
fs.mkdirSync(reviewPacksDir, { recursive: true });

// FIX-R2-03: release tag is explicit, not hard-coded to R1/R2.
// Usage: node scripts/build-release.mjs [--r1|--r3|--tag=R3]
// Default remains R2 for backward compatibility. R3 (and later) tags
// generate the matching -r3 zip/manifest/sums/index/log names, so a
// new freeze can never silently reuse an R2 (or R1) file name.
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
// FIX-R2-03 (independent-review follow-up): tag allowlist. An empty
// or path-containing tag previously produced names like dist-release-.zip
// or paths escaping release/, and --r1 silently won over --r3.
if (process.argv.includes('--r1') && process.argv.includes('--r3')) {
  throw new Error('Conflicting flags: --r1 and --r3 cannot both be passed');
}
const releaseTag = tagArg
  ? tagArg.slice('--tag='.length).toUpperCase()
  : process.argv.includes('--r1')
    ? 'R1'
    : process.argv.includes('--r3')
      ? 'R3'
      : 'R2';
if (!/^[A-Z][A-Z0-9]{0,7}$/.test(releaseTag)) {
  throw new Error(`Invalid release tag "${releaseTag}": expected R1/R2/R3-style, letters/digits only, starting with a letter`);
}
const tagSuffix = releaseTag === 'R1' ? '' : `-${releaseTag.toLowerCase()}`;
const logFileName = releaseTag === 'R1' ? 'T018-release.txt' : `T018-${releaseTag}-release.txt`;
const distZipName = `dist-release${tagSuffix}.zip`;
const sourceZipName = `source-release${tagSuffix}.zip`;
const manifestCsvName = releaseTag === 'R1' ? 'SOURCE_MANIFEST.csv' : `SOURCE_MANIFEST_${releaseTag}.csv`;
const sha256SumsName = releaseTag === 'R1' ? 'SHA256SUMS.txt' : `SHA256SUMS_${releaseTag}.txt`;
const reviewIndexName = releaseTag === 'R1' ? 'REVIEW_INDEX.md' : `REVIEW_INDEX_${releaseTag}.md`;
const releaseNotesName = releaseTag === 'R1' ? 'RELEASE_NOTES.md' : `RELEASE_NOTES_${releaseTag}.md`;

const logFilePath = path.resolve(valLogsDir, logFileName);
const logBuffer = [];

function log(msg = '') {
  console.log(msg);
  logBuffer.push(msg);
}

function flushLog() {
  fs.writeFileSync(logFilePath, logBuffer.join('\n') + '\n', 'utf8');
}

function computeSha256(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

function runStep(cmd, args, description) {
  log('================================================================================');
  log(`COMMAND: ${cmd} ${args.join(' ')}`);
  log(`DESCRIPTION: ${description}`);
  log(`START_TIME_UTC: ${new Date().toISOString()}`);
  log('--------------------------------------------------------------------------------');

  const startTime = Date.now();
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, TMPDIR: tmpDir },
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe']
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
    logBuffer.push(result.stdout.trimEnd());
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
    logBuffer.push(result.stderr.trimEnd());
  }

  const durationMs = Date.now() - startTime;
  log('--------------------------------------------------------------------------------');
  log(`EXIT_CODE: ${result.status}`);
  log(`DURATION_MS: ${durationMs}`);
  log(`END_TIME_UTC: ${new Date().toISOString()}`);

  if (result.status !== 0) {
    flushLog();
    throw new Error(`Step failed with exit code ${result.status}: ${cmd} ${args.join(' ')}`);
  }
}

async function main() {
  const scriptStartTime = new Date().toISOString();
  log('================================================================================');
  log(`P010 GAINFRONT OFFICIAL RELEASE BUNDLE EXECUTION (P010-T018-${releaseTag})`);
  log('================================================================================');
  log(`SCRIPT_START_UTC: ${scriptStartTime}`);
  log(`TARGET_CWD: ${cwd}`);
  log(`RELEASE_TAG: ${releaseTag}`);
  log(`NODE_VERSION: ${process.version}`);
  log(`PLATFORM: ${process.platform} ${process.arch}`);
  log(`TMPDIR: ${process.env.TMPDIR}`);
  log('');

  // 1. Clean Rebuild Sequence
  log('>>> PHASE 1: CLEAN REBUILD (npm ci, typecheck, test, build)');
  runStep('npm', ['ci'], 'Clean reproducible dependency installation');
  runStep('npm', ['run', 'typecheck'], 'TypeScript static type checking (tsc --noEmit)');
  runStep('npm', ['test'], 'Vitest unit, math, and oracle suite (vitest run)');
  runStep('npm', ['run', 'build'], 'Vite production build (tsc --noEmit && vite build)');

  log('\n>>> PHASE 2: STATIC DIST PACKAGING');
  const distDir = path.resolve(cwd, 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ directory does not exist after build!');
  }
  const distZipPath = path.resolve(releaseDir, distZipName);
  if (fs.existsSync(distZipPath)) {
    fs.unlinkSync(distZipPath);
  }

  // Package dist zip
  execSync(`(cd "${distDir}" && zip -q -r "${distZipPath}" .)`);
  const distZipStat = fs.statSync(distZipPath);
  const distZipHash = computeSha256(distZipPath);
  log(`Created ${distZipName}: ${distZipStat.size} bytes, SHA-256: ${distZipHash}`);

  // Flush rebuild logs so validation log is complete and can be included in source-release
  log('\n>>> PHASE 3: SOURCE TREE MANIFEST & PACKAGING');
  flushLog();

  // Exclude list for source-release.zip
  const excludedRelPaths = new Set([
    'node_modules',
    'dist',
    '.tmp',
    'release',
    'test-results',
    '.git',
    'evidence/review-packs'
  ]);

  // FIX-R2-03 (second independent review): the CURRENT build log is
  // self-referential — it is written by this script, so including it
  // in the manifest it generates guarantees a stale size/SHA (the
  // manifest is written mid-build, the log is flushed again at the
  // end). Exclude only the current log file from the source zip;
  // historical logs (e.g. T018-release.txt, T018-R2-release.txt) are
  // already frozen and remain included. The full final R3 log is
  // preserved as review-folder evidence by generate-review-packs.mjs
  // (--build-log), not as a frozen source file.
  const currentLogRel = path.relative(cwd, logFilePath).replace(/\\/g, '/');
  function isExcluded(rel) {
    const normalized = rel.replace(/\\/g, '/');
    if (normalized === currentLogRel) return true;
    for (const prefix of excludedRelPaths) {
      if (normalized === prefix || normalized.startsWith(prefix + '/')) {
        return true;
      }
    }
    // Exclude temp and editor backup files
    const basename = path.basename(normalized);
    if (basename.endsWith('.tmp') || basename.endsWith('~') || basename.startsWith('.#') || (basename.startsWith('.') && basename.endsWith('.swp'))) {
      return true;
    }
    return false;
  }

  function collectFiles(dir) {
    const list = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      const relPath = path.relative(cwd, fullPath).replace(/\\/g, '/');
      if (isExcluded(relPath)) continue;
      if (ent.isDirectory()) {
        list.push(...collectFiles(fullPath));
      } else if (ent.isFile()) {
        list.push(relPath);
      }
    }
    return list;
  }

  const allSourceFiles = collectFiles(cwd).sort();
  log(`Total files identified for ${sourceZipName}: ${allSourceFiles.length}`);

  // Write SOURCE_MANIFEST
  const manifestCsvPath = path.resolve(releaseDir, manifestCsvName);
  const manifestRows = ['path,size_bytes,sha256'];
  for (const rel of allSourceFiles) {
    const absPath = path.resolve(cwd, rel);
    const size = fs.statSync(absPath).size;
    const sha = computeSha256(absPath);
    manifestRows.push(`${rel},${size},${sha}`);
  }
  fs.writeFileSync(manifestCsvPath, manifestRows.join('\n') + '\n', 'utf8');
  log(`Generated ${manifestCsvName} with ${allSourceFiles.length} files.`);

  // Package source zip
  const sourceZipPath = path.resolve(releaseDir, sourceZipName);
  if (fs.existsSync(sourceZipPath)) {
    fs.unlinkSync(sourceZipPath);
  }
  const filelistTmp = path.resolve(tmpDir, 'source_filelist.txt');
  fs.writeFileSync(filelistTmp, allSourceFiles.join('\n') + '\n', 'utf8');
  execSync(`zip -q -@ "${sourceZipPath}" < "${filelistTmp}"`, { cwd });
  fs.unlinkSync(filelistTmp);

  const sourceZipStat = fs.statSync(sourceZipPath);
  const sourceZipHash = computeSha256(sourceZipPath);
  log(`Created ${sourceZipName}: ${sourceZipStat.size} bytes, SHA-256: ${sourceZipHash}`);

  // 4. SHA256SUMS
  log(`\n>>> PHASE 4: ${sha256SumsName} GENERATION`);
  const sha256SumsPath = path.resolve(releaseDir, sha256SumsName);
  const sumsContent = `${sourceZipHash}  ${sourceZipName}\n${distZipHash}  ${distZipName}\n`;
  fs.writeFileSync(sha256SumsPath, sumsContent, 'utf8');
  log(`Generated ${sha256SumsName}:\n${sumsContent}`);

  // 5. Verification
  log('>>> PHASE 5: INTEGRITY SELF-CHECK');
  // Check unzip list against manifest
  const unzippedList = execSync(`unzip -Z1 "${sourceZipPath}"`, { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();

  if (unzippedList.length !== allSourceFiles.length) {
    throw new Error(`File count mismatch in zip: got ${unzippedList.length}, expected ${allSourceFiles.length}`);
  }

  for (let i = 0; i < allSourceFiles.length; i++) {
    if (unzippedList[i] !== allSourceFiles[i]) {
      throw new Error(`File mismatch in zip at index ${i}: zip has ${unzippedList[i]}, manifest has ${allSourceFiles[i]}`);
    }
  }
  log(`[VERIFY PASS] All ${allSourceFiles.length} files in ${sourceZipName} match ${manifestCsvName} exactly.`);

  // Check sha256sum verification command
  const checkResult = execSync(`(cd "${releaseDir}" && sha256sum -c ${sha256SumsName})`, { encoding: 'utf8' });
  log(`[VERIFY PASS] sha256sum check:\n${checkResult.trim()}`);

  // FIX-R2-03: review-index sync must not silently do nothing.
  // In R2 this block looked in evidence/review-packs (a directory that
  // is excluded from the source zip and is not where the review index
  // lives), found nothing, and the stale index survived. The
  // authoritative R3 index is now regenerated from the final source by
  // scripts/generate-review-packs.mjs AFTER this build; this block only
  // syncs an index that actually exists here, and warns loudly if the
  // zip rows are not found, instead of claiming a sync.
  const reviewIndexPath = path.resolve(reviewPacksDir, reviewIndexName);
  if (fs.existsSync(reviewIndexPath)) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let indexContent = fs.readFileSync(reviewIndexPath, 'utf8');
    const before = indexContent;
    const sourceRegex = new RegExp(`\\| \`release\\/${escapeRe(sourceZipName)}\` \\| [^|]+ \\| \`[^|]+\` \\|`);
    const distRegex = new RegExp(`\\| \`release\\/${escapeRe(distZipName)}\` \\| [^|]+ \\| \`[^|]+\` \\|`);
    indexContent = indexContent.replace(
      sourceRegex,
      `| \`release/${sourceZipName}\` | ${sourceZipStat.size.toLocaleString()} bytes | \`${sourceZipHash}\` |`
    );
    indexContent = indexContent.replace(
      distRegex,
      `| \`release/${distZipName}\` | ${distZipStat.size.toLocaleString()} bytes | \`${distZipHash}\` |`
    );
    // Also update log file row in file inventory table
    const logStat = fs.statSync(logFilePath);
    const logHash = computeSha256(logFilePath);
    const logRel = path.relative(cwd, logFilePath).replace(/\\/g, '/');
    const logRegex = new RegExp(`(\\| \\d+ \\| \`${escapeRe(logRel)}\` \\| )[^|]+( \\| \`)[^|]+(\` \\| .*)`);
    indexContent = indexContent.replace(logRegex, `$1${logStat.size.toLocaleString()}$2${logHash}$3`);

    if (indexContent === before) {
      log(`[SYNC WARNING] ${reviewIndexName} exists but its zip rows were NOT updated (pattern did not match). The index must be regenerated by scripts/generate-review-packs.mjs; do not ship a stale index.`);
    } else {
      fs.writeFileSync(reviewIndexPath, indexContent, 'utf8');
      log(`[SYNC] Updated zip hashes, sizes, and log file metadata in ${reviewIndexName}`);
    }
  } else {
    // FIX-R2-03 (independent-review follow-up): an absent index is a
    // WARNING, not a quiet SKIP — it is the default path for a fresh
    // tree, and a stale/missing index must never ship unnoticed.
    log(`[SYNC WARNING] No ${reviewIndexName} in ${reviewPacksDir}; the authoritative index MUST be regenerated from the final source by scripts/generate-review-packs.mjs before any review submission.`);
  }

  // If release notes exist, update the frozen zip hashes and sizes
  const releaseNotesPath = path.resolve(releaseDir, releaseNotesName);
  if (fs.existsSync(releaseNotesPath)) {
    let notesContent = fs.readFileSync(releaseNotesPath, 'utf8');
    const escapeRe2 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sourceRegex = new RegExp(`\\| \`${escapeRe2(sourceZipName)}\` \\| [^|]+ \\| \`[^|]+\` \\|`);
    const distRegex = new RegExp(`\\| \`${escapeRe2(distZipName)}\` \\| [^|]+ \\| \`[^|]+\` \\|`);
    notesContent = notesContent.replace(
      sourceRegex,
      `| \`${sourceZipName}\` | ${sourceZipStat.size.toLocaleString()} bytes | \`${sourceZipHash}\` |`
    );
    notesContent = notesContent.replace(
      distRegex,
      `| \`${distZipName}\` | ${distZipStat.size.toLocaleString()} bytes | \`${distZipHash}\` |`
    );
    fs.writeFileSync(releaseNotesPath, notesContent, 'utf8');
    log(`[SYNC] Updated zip hashes and sizes in ${releaseNotesName}`);
  } else {
    log(`[SYNC WARNING] No ${releaseNotesName} in release/; release notes were NOT updated and must be created/checked before submission.`);
  }

  log('\n================================================================================');
  log(`P010 ${releaseTag} RELEASE BUNDLE COMPLETED SUCCESSFULLY`);
  log(`SOURCE_RELEASE_ZIP: ${sourceZipStat.size} bytes | SHA256: ${sourceZipHash}`);
  log(`DIST_RELEASE_ZIP:   ${distZipStat.size} bytes | SHA256: ${distZipHash}`);
  log('================================================================================\n');

  flushLog();
}

main().catch((err) => {
  log(`\nFATAL ERROR: ${err.message}`);
  flushLog();
  console.error(err);
  process.exit(1);
});
