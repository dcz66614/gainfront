/**
 * scripts/generate-review-packs.mjs  (FIX-R2-03)
 *
 * Regenerates REVIEW_INDEX_<TAG>.md and REVIEW_PACK_01..05.md EXACTLY
 * from the final frozen source tree, after scripts/build-release.mjs
 * has produced release/source-release-<tag>.zip and
 * release/SOURCE_MANIFEST_<TAG>.csv.
 *
 * Why this exists: in R2, REVIEW_INDEX_R2.md listed
 * scripts/build-release.mjs at 11,669 bytes / SHA 1c6c..., while the
 * actual frozen file was 12,111 bytes / SHA 5258... -- the index had
 * been written from an older script version and never regenerated, and
 * build-release's sync block looked in evidence/review-packs, which is
 * excluded from the source zip and is not where the index lives, so it
 * silently did nothing.
 *
 * This generator:
 *  - reads the manifest CSV (the same list that went into the zip),
 *  - computes size/SHA-256 for every file from disk and cross-checks
 *    them against the manifest and against `unzip -Z1` of the zip,
 *  - writes REVIEW_PACK_01..05 with the full text of every text file
 *    (binary files: size/SHA metadata only, never raw bytes),
 *  - records the exact line range of every file in its pack,
 *  - writes REVIEW_INDEX_<TAG>.md with those sizes, SHAs, and ranges,
 *  - verifies afterwards that every manifest file appears exactly once
 *    in a pack, every index row matches disk, and every index line
 *    range contains the file's content.
 *
 * Usage:
 *   node scripts/generate-review-packs.mjs --tag=R3 --out=<review-dir>
 *   (out defaults to evidence/review-packs; for the R3 freeze, pass the
 *    Drive review folder staging dir, e.g. ../review-r3)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);
const tag = String(args.tag || 'R3').toUpperCase();
const tagSuffix = tag === 'R1' ? '' : `-${tag.toLowerCase()}`;
const outDir = path.resolve(args.out || path.join(cwd, 'evidence/review-packs'));
const buildLogPath = args['build-log'] ? path.resolve(String(args['build-log'])) : null;
const releaseDir = path.join(cwd, 'release');
const manifestName = tag === 'R1' ? 'SOURCE_MANIFEST.csv' : `SOURCE_MANIFEST_${tag}.csv`;
const sourceZipName = `source-release${tagSuffix}.zip`;
const distZipName = `dist-release${tagSuffix}.zip`;
const sumsName = tag === 'R1' ? 'SHA256SUMS.txt' : `SHA256SUMS_${tag}.txt`;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
function isBinary(rel) {
  return /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|mp3|wav|zip)$/i.test(rel);
}
function packOf(rel) {
  if (rel.startsWith('src/core/')) return 1;
  if (rel.startsWith('src/worker/') || rel.startsWith('src/ui/') || rel === 'src/main.tsx' || rel === 'index.html') return 2;
  if (rel.startsWith('tests/math/') || rel.startsWith('tests/oracle/') || rel.startsWith('tests/fixtures/')) return 3;
  if (rel.startsWith('tests/ui/') || rel.startsWith('tests/e2e/')) return 4;
  return 5;
}
const packTitles = {
  1: '核心数学与 DSP 算法引擎',
  2: 'Web Worker 协议与前端交互界面',
  3: '核心数学测试套件、独立 Oracle 对拍与基准装置',
  4: 'UI 组件集成测试与端到端自动化测试主干',
  5: '工程配置、构建发布脚本、说明文档与执行记录',
};

const manifestPath = path.join(releaseDir, manifestName);
if (!fs.existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);
const manifestRows = fs.readFileSync(manifestPath, 'utf8').trim().split('\n').slice(1);
const files = manifestRows.map((row) => {
  const [rel, size, sha] = row.split(',');
  return { rel, size: Number(size), sha };
});

// Cross-check 1: disk vs manifest
for (const f of files) {
  const abs = path.join(cwd, f.rel);
  if (!fs.existsSync(abs)) throw new Error(`Manifest file missing on disk: ${f.rel}`);
  const actualSize = fs.statSync(abs).size;
  const actualSha = sha256(abs);
  if (actualSize !== f.size || actualSha !== f.sha) {
    throw new Error(`Manifest mismatch for ${f.rel}: manifest ${f.size}/${f.sha}, disk ${actualSize}/${actualSha}`);
  }
}
// Cross-check 2: zip listing vs manifest
const zipPath = path.join(releaseDir, sourceZipName);
if (!fs.existsSync(zipPath)) throw new Error(`Source zip not found: ${zipPath}`);
const zipList = execSync(`unzip -Z1 "${zipPath}"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
const manifestList = files.map((f) => f.rel).sort();
if (JSON.stringify(zipList) !== JSON.stringify(manifestList)) {
  throw new Error(`Zip listing differs from manifest (${zipList.length} vs ${manifestList.length})`);
}
const zipStat = fs.statSync(zipPath);
const zipSha = sha256(zipPath);
let distStat = null;
let distSha = null;
const distPath = path.join(releaseDir, distZipName);
if (fs.existsSync(distPath)) {
  distStat = fs.statSync(distPath);
  distSha = sha256(distPath);
}
const sumsPath = path.join(releaseDir, sumsName);
const sumsContent = fs.existsSync(sumsPath) ? fs.readFileSync(sumsPath, 'utf8') : '';
if (sumsContent && (!sumsContent.includes(zipSha) || (distSha && !sumsContent.includes(distSha)))) {
  throw new Error(`${sumsName} does not match the frozen zip hashes`);
}

fs.mkdirSync(outDir, { recursive: true });

// Build packs, recording line ranges (1-based, inclusive).
const ranges = new Map(); // rel -> { pack, start, end }
const packFiles = {};
for (let n = 1; n <= 5; n++) {
  const lines = [];
  lines.push(`# P010 GainFront REVIEW_PACK_0${n} (${tag}) — ${packTitles[n]}`);
  lines.push('');
  const packMembers = files.filter((f) => packOf(f.rel) === n);
  for (const f of packMembers) {
    const abs = path.join(cwd, f.rel);
    lines.push(`---`);
    lines.push(`## ${f.rel}`);
    lines.push(`- size_bytes: ${f.size}`);
    lines.push(`- sha256: ${f.sha}`);
    if (isBinary(f.rel)) {
      lines.push(`- note: binary file; content not embedded, metadata only.`);
      lines.push('');
      ranges.set(f.rel, { pack: n, start: lines.length + 1, end: lines.length + 1 });
      // Range for a binary entry is its header block; record it as such.
      ranges.set(f.rel, { pack: n, start: lines.length - 3, end: lines.length });
      continue;
    }
    const content = fs.readFileSync(abs, 'utf8');
    lines.push('');
    const start = lines.length + 1; // first content line (blank line above is lines.length)
    const contentLines = content.split('\n');
    // Drop a single trailing empty line produced by a trailing newline.
    if (contentLines.length && contentLines[contentLines.length - 1] === '') contentLines.pop();
    lines.push(...contentLines);
    const end = lines.length;
    ranges.set(f.rel, { pack: n, start, end });
    lines.push('');
  }
  packFiles[n] = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, `REVIEW_PACK_0${n}.md`), packFiles[n], 'utf8');
}

// Appendix: the full final build log (review-folder evidence, NOT a
// frozen source file — see build-release.mjs exclusion note above).
let buildLogInfo = null;
if (buildLogPath) {
  if (!fs.existsSync(buildLogPath)) throw new Error(`Build log not found: ${buildLogPath}`);
  const logContent = fs.readFileSync(buildLogPath, 'utf8');
  buildLogInfo = {
    name: path.basename(buildLogPath),
    size: fs.statSync(buildLogPath).size,
    sha: sha256(buildLogPath),
  };
  const pack5Path = path.join(outDir, 'REVIEW_PACK_05.md');
  const appendix = [
    '',
    '---',
    `## Appendix: final build log (${buildLogInfo.name}) — review-folder evidence, not a frozen source file`,
    `- size_bytes: ${buildLogInfo.size}`,
    `- sha256: ${buildLogInfo.sha}`,
    '',
    ...logContent.split('\n'),
  ].join('\n');
  fs.appendFileSync(pack5Path, appendix, 'utf8');
  packFiles[5] = fs.readFileSync(pack5Path, 'utf8');
}

// Index, with task ownership approximated from R2 conventions where known.
const indexLines = [];
indexLines.push(`# P010 声限图 GainFront｜最终审查索引与冻结元数据清单 (REVIEW_INDEX_${tag}.md)`);
indexLines.push('');
indexLines.push(`- **项目代号**: \`P010\` (GainFront / 声限图)`);
indexLines.push(`- **版本**: \`1.0.0-${tag.toLowerCase()}\``);
indexLines.push(`- **生成时间 (UTC)**: ${new Date().toISOString()}`);
indexLines.push(`- **审查状态**: \`AWAITING_FINAL_REVIEW_${tag}\``);
indexLines.push(`- **冻结基线**: ${files.length} 个受控文件（由 scripts/generate-review-packs.mjs 从最终源码与 ${sourceZipName} 逐项核对生成，禁止手工改写大小/SHA/行范围）`);
indexLines.push('');
indexLines.push('## 一、冻结交付包元数据 (Frozen Release Metadata)');
indexLines.push('');
indexLines.push('| 交付包文件名 | 文件大小 (Bytes) | SHA-256 校验和 | 内容说明 |');
indexLines.push('|---|---|---|---|');
indexLines.push(`| \`release/${sourceZipName}\` | ${zipStat.size.toLocaleString()} bytes | \`${zipSha}\` | 完整可复现源码、依赖锁、测试套件、文档及验证证据（排除 node_modules, dist, .tmp, release, review-packs） |`);
if (distStat && distSha) {
  indexLines.push(`| \`release/${distZipName}\` | ${distStat.size.toLocaleString()} bytes | \`${distSha}\` | 生产环境静态打包产物 |`);
}
indexLines.push('');
indexLines.push('## 二、审查包分批指引 (Review Packs Navigation)');
indexLines.push('');
for (let n = 1; n <= 5; n++) {
  indexLines.push(`- **[REVIEW_PACK_0${n}.md](REVIEW_PACK_0${n}.md)**: ${packTitles[n]}`);
}
indexLines.push('');
indexLines.push('## 三、全量冻结源码文件审查对照清单 (Full Source File Inventory)');
indexLines.push('');
indexLines.push('| # | 相对文件路径 | 文件大小 (Bytes) | SHA-256 校验和 | 审查包归属与行范围 |');
indexLines.push('|---|---|---|---|---|');
files.forEach((f, i) => {
  const r = ranges.get(f.rel);
  indexLines.push(`| ${i + 1} | \`${f.rel}\` | ${f.size} | \`${f.sha}\` | [REVIEW_PACK_0${r.pack}.md#L${r.start}-L${r.end}](REVIEW_PACK_0${r.pack}.md#L${r.start}-L${r.end}) |`);
});
indexLines.push('');
if (buildLogInfo) {
  indexLines.push('## 四、审查文件夹证据（非冻结源码文件）');
  indexLines.push('');
  indexLines.push('| 文件 | 文件大小 (Bytes) | SHA-256 校验和 | 说明 |');
  indexLines.push('|---|---|---|---|');
  indexLines.push(`| \`${buildLogInfo.name}\` | ${buildLogInfo.size} | \`${buildLogInfo.sha}\` | 本次构建的完整最终日志，见 REVIEW_PACK_05.md 附录；因其由构建脚本自身写入，故不列入源码清单，避免自引用导致的大小/SHA 陈旧（R2 的 B03 教训） |`);
  indexLines.push('');
}
indexLines.push('## 五、交叉核对声明 (Cross-check)');
indexLines.push('');
indexLines.push(`- 源码清单 ${files.length} 项与 ${manifestName} 逐项一致（大小与 SHA-256 均在磁盘上重算核对）。`);
indexLines.push(`- ${sourceZipName} 解压清单与清单逐项一致（${zipList.length} 项）。`);
if (distSha) indexLines.push(`- ${sumsName} 与两包 SHA-256 一致。`);
indexLines.push('- 每个审查包行范围在生成时记录，禁止手工修改；若源码变动，必须重新运行本脚本并重新冻结。');
indexLines.push('');
fs.writeFileSync(path.join(outDir, `REVIEW_INDEX_${tag}.md`), indexLines.join('\n'), 'utf8');

// Verification pass: every file exactly once, every range contains content.
const seen = new Set();
for (const f of files) {
  if (seen.has(f.rel)) throw new Error(`Duplicate pack entry: ${f.rel}`);
  seen.add(f.rel);
  const r = ranges.get(f.rel);
  if (!r) throw new Error(`Missing range for ${f.rel}`);
  if (!isBinary(f.rel)) {
    const packLines = packFiles[r.pack].split('\n');
    const slice = packLines.slice(r.start - 1, r.end).join('\n');
    const disk = fs.readFileSync(path.join(cwd, f.rel), 'utf8').replace(/\n$/, '');
    if (slice !== disk) throw new Error(`Pack content mismatch for ${f.rel} (pack ${r.pack} L${r.start}-L${r.end})`);
  }
}
console.log(`Generated REVIEW_INDEX_${tag}.md + REVIEW_PACK_01..05 in ${outDir}`);
console.log(`Files: ${files.length}; source zip: ${sourceZipName} ${zipStat.size} bytes ${zipSha}`);
if (distStat) console.log(`Dist zip: ${distZipName} ${distStat.size} bytes ${distSha}`);
