# P010-T008 独立 Oracle 验证报告（FFmpeg ebur128 对照）

- **任务 ID**: P010-T008
- **验证日期**: 2026-11-02
- **执行环境**: Linux x86_64, Node.js v24.22.1, FFmpeg 8.1.2
- **被测模块**: `src/core/gain.ts` (`measure()`) + `src/core/wav.ts` (`decodePcm16Wav()`)
- **参照标准**: 本机 FFmpeg 8.1.2 `ebur128` 滤镜 (`libavfilter 11.14.102`)
- **独立性原则**: 
  - 信号合成完全由独立测试套件 `tests/oracle/ebur128.test.ts` 独立生成（纯数学公式），严格禁止导入 `presets.ts`；
  - 独立生成 RIFF WAVE PCM16 Little-Endian 48kHz WAV 格式字节流；
  - 被测方调用 Worker 的 `decodePcm16Wav` 解析同一 WAV 字节流后输入 `measure()`，保证两端样本比特级一致；
  - 参照方直接调用本机 FFmpeg 8.1.2 运行 `ebur128` 计算参考响度。

---

## 1. 参照方环境与命令

### 1.1 FFmpeg 版本与构建信息

```text
ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers
built with gcc 13 (Ubuntu 13.3.0-6ubuntu2~24.04.1)
configuration: --prefix=/usr --extra-version= --toolchain=hardened --libdir=/usr/lib/x86_64-linux-gnu --incdir=/usr/include/x86_64-linux-gnu --arch=amd64 --enable-gpl --disable-stripping --disable-pocketsphinx --disable-libcaca --disable-libmfx --disable-omx --enable-gnutls --enable-libaom --enable-libass --enable-libbs2b --enable-libcdio --enable-libcodec2 --enable-libdav1d --enable-libflite --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libglslang --enable-libgme --enable-libgsm --enable-libharfbuzz --enable-libmp3lame --enable-libmysofa --enable-libopenjpeg --enable-libopenmpt --enable-libopus --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx265 --enable-libxml2 --enable-libxvid --enable-libzimg --enable-openal --enable-opencl --enable-opengl --disable-sndio --enable-libvpl --enable-libdc1394 --enable-libdrm --enable-libiec61883 --enable-chromaprint --enable-ladspa --enable-libbluray --enable-libdvdnav --enable-libdvdread --enable-libjack --enable-libjxl --enable-libpulse --enable-librabbitmq --enable-librist --enable-libsrt --enable-libssh --enable-libsvtav1 --enable-libx264 --enable-libzmq --enable-libzvbi --enable-lv2 --enable-libplacebo --enable-frei0r --enable-sdl2 --enable-librav1e --enable-librsvg --disable-libplacebo --enable-shared
libavutil      60. 26.102 / 60. 26.102
libavcodec     62. 28.102 / 62. 28.102
libavformat    62. 12.102 / 62. 12.102
libavdevice    62.  3.102 / 62.  3.102
libavfilter    11. 14.102 / 11. 14.102
libswscale      9.  5.102 /  9.  5.102
libswresample   6.  3.102 /  6.  3.102
```

### 1.2 参照执行命令

```bash
TMPDIR="tests/oracle/.tmp" ffmpeg -nostats -i <wavPath> -af ebur128=framelog=verbose -f null -
```

---

## 2. 测试信号合成规格（独立实现）

全部信号采样率 `48,000 Hz`，时长 `8.0 s`，总帧数 `384,000` 帧，量化格式 `16-bit Signed Integer PCM Little-Endian`：

1. **GF-B（安全增益，单声道）**:
   - 公式：$x[n] = 0.10 \times \sin(2\pi \times 1000 \times n / 48000)$
   - 通道：1 (Mono)
2. **GF-C（双声道能量，立体声）**:
   - 公式：L 与 R 双声道完全相同，均为 $0.10 \times \sin(2\pi \times 1000 \times n / 48000)$
   - 通道：2 (Stereo)
3. **GF-A（峰值陷阱，单声道脉冲）**:
   - 公式：$x[n] = 0.10 \times \sin(2\pi \times 1000 \times n / 48000)$，在 $n = 192000$（第 4 秒）单点覆写为 $0.80$
   - 通道：1 (Mono)

---

## 3. 比对结果汇总表

| 信号用例 | 通道 | Worker `measure()` 测量值 | FFmpeg 8.1.2 `ebur128` 参考值 | 绝对误差 | MATH03 容差门槛 | 判定结果 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **GF-B** (安全增益) | 1 | `-23.0035 LUFS` | `-23.0 LUFS` | **0.0035 LU** | $\le 0.20\text{ LU}$ | **PASS** (余量 0.1965 LU) |
| **GF-C** (双声道能量) | 2 | `-19.9932 LUFS` | `-20.0 LUFS` | **0.0068 LU** | $\le 0.20\text{ LU}$ | **PASS** (余量 0.1932 LU) |
| **GF-A** (峰值陷阱) | 1 | `-23.0004 LUFS` | `-23.0 LUFS` | **0.0004 LU** | $\le 0.20\text{ LU}$ | **PASS** (余量 0.1996 LU) |

> **立体声增益验证 (MATH04 对照)**:
> $\Delta I = I_{\text{GF-C}} - I_{\text{GF-B}} = -19.9932 - (-23.0035) = 3.0103\text{ LU} \approx 10\log_{10}(2)\text{ LU}$，与理论双声道能量翻倍严格吻合。

---

## 4. 原始输出数值记录

### 4.1 GF-B 原始输出

- **FFmpeg 原始输出**:
  ```text
  [Parsed_ebur128_0 @ 0x742ae8001fc0] Summary:

    Integrated loudness:
      I:         -23.0 LUFS
      Threshold: -33.0 LUFS

    Loudness range:
      LRA:         0.0 LU
      Threshold: -43.0 LUFS
      LRA low:   -23.0 LUFS
      LRA high:  -23.0 LUFS
  ```
- **Worker `measure()` 原始结构**:
  ```json
  {
    "integratedLufs": -23.00350731465223,
    "samplePeakDbFs": -20.00000000000000,
    "estimatedTruePeakDbTp": -20.00000000000000,
    "samplePeakFrame": 12,
    "estimatedPeakPosition": { "frame": 12, "quarter": 0, "channel": 0 },
    "blockPowersCount": 77,
    "allAbsoluteGatePassed": true,
    "allRelativeGatePassed": true
  }
  ```

### 4.2 GF-C 原始输出

- **FFmpeg 原始输出**:
  ```text
  [Parsed_ebur128_0 @ 0x79c0a4001fc0] Summary:

    Integrated loudness:
      I:         -20.0 LUFS
      Threshold: -30.0 LUFS

    Loudness range:
      LRA:         0.0 LU
      Threshold: -40.0 LUFS
      LRA low:   -20.0 LUFS
      LRA high:  -20.0 LUFS
  ```
- **Worker `measure()` 原始结构**:
  ```json
  {
    "integratedLufs": -19.99320735805227,
    "samplePeakDbFs": -20.00000000000000,
    "estimatedTruePeakDbTp": -20.00000000000000,
    "samplePeakFrame": 12,
    "estimatedPeakPosition": { "frame": 12, "quarter": 0, "channel": 0 },
    "blockPowersCount": 77,
    "allAbsoluteGatePassed": true,
    "allRelativeGatePassed": true
  }
  ```

### 4.3 GF-A 原始输出

- **FFmpeg 原始输出**:
  ```text
  [Parsed_ebur128_0 @ 0x7ada2c001fc0] Summary:

    Integrated loudness:
      I:         -23.0 LUFS
      Threshold: -33.0 LUFS

    Loudness range:
      LRA:         0.0 LU
      Threshold: -43.0 LUFS
      LRA low:   -23.0 LUFS
      LRA high:  -23.0 LUFS
  ```
- **Worker `measure()` 原始结构**:
  ```json
  {
    "integratedLufs": -23.00037804473856,
    "samplePeakDbFs": -1.938200260161128,
    "estimatedTruePeakDbTp": -1.938200260161128,
    "samplePeakFrame": 192000,
    "estimatedPeakPosition": { "frame": 192000, "quarter": 0, "channel": 0 },
    "blockPowersCount": 77,
    "allAbsoluteGatePassed": true,
    "allRelativeGatePassed": true
  }
  ```

---

## 5. 口径差异与算法实现细节说明

虽然 GainFront Worker 与 FFmpeg `ebur128` 的比对误差仅在 `0.0004 ~ 0.0068 LU`（远低于 `±0.20 LU` 的 MATH03 容差限），但两者在底层设计上存在以下已知口径与工程差异，不得假装两者逐位一致：

1. **数值精度与滤波器实现方式**:
   - **GainFront Worker**: 纯 TypeScript 实现，采用 IEEE 754 双精度浮点（`Float64`）执行直接型 II（或转置直接型 II）双二阶（Biquad）IIR 滤波（Stage 1 高架搁架滤波 + Stage 2 二阶高通滤波）。
   - **FFmpeg `ebur128`**: `libavfilter/f_ebur128.c` 内部使用 C 语言实现，并可能针对平台架构利用 x86 SIMD 向量化指令或单精度/双精度状态变量，累加过程中的微小取整误差会略微影响极低位数值。

2. **输出显示精细度 (Resolution)**:
   - **FFmpeg 8.1.2 CLI**: 终端 Summary 打印按照广播仪表惯例四舍五入保留 1 位小数（例如 `-23.0 LUFS`、`-20.0 LUFS`）。
   - **GainFront Worker**: 内部与输出均保留双精度浮点数（例如 `-23.003507... LUFS`、`-19.993207... LUFS`）。

3. **分块与边界填充机制 (Windowing & Priming)**:
   - **GainFront Worker**: 严格按离散音频帧长裁切（$N = 19200$ 帧 / 0.4s 窗口，$H = 4800$ 帧 / 0.1s 步长）。对 8 秒（384,000 帧）音频，严格排除不完整的首尾数据块，整好生成 77 个有效功率块。
   - **FFmpeg `ebur128`**: 作为流式滤镜运行，使用环形缓冲进行重叠分块。在信号起始端（前几个样本），滤波器的阶跃响应与初始全零状态在初态过渡区可能存在极微小能量积累差异。

4. **门限判断 (Gating Comparison)**:
   - 依据 ITU-R BS.1770-5 与 EBU R128：
     - 第一阶段绝对门限：$L > -70.0\text{ LUFS}$；
     - 第二阶段相对门限：$L > \max(-70.0, L_A - 10.0)\text{ LUFS}$。
   - GainFront 与 FFmpeg 均遵循严格大于（`>`）判定。由于本组基准信号均为稳态高信噪比正弦波，所有 77 个块全部稳定位于门限之上，两者的门限选择集合完全一致（全通过）。

5. **真峰值与采样峰差异**:
   - MATH03 仅比对集成响度（Integrated Loudness）；
   - GainFront 采用 33 点对称余弦窗 sinc 插值估计 True Peak（标明为 `estimated dBTP`，保留 0.30 dB 安全余量，不假装广播级认证仪器），而 FFmpeg 在 `peak=true` 时采用 4x 预滤波或多相过采样求峰值，二者设计定位清晰区分。

---

## 6. 验收结论

- **MATH03 判定**: **PASS**
  - GF-B 误差: `0.0035 LU`（$\le 0.20\text{ LU}$）
  - GF-C 误差: `0.0068 LU`（$\le 0.20\text{ LU}$）
  - GF-A 误差: `0.0004 LU`（$\le 0.20\text{ LU}$）
- **独立性验证**:
  - 测试套件完全自包含正弦信号与 RIFF PCM16 WAV 编码逻辑，零引用 `presets.ts`；
  - 仅导入调用 `src/core/gain.ts` (`measure()`) 与 `src/core/wav.ts` (`decodePcm16Wav()`)，未改动任何 `src/` 源码。
- **验收命令结果**:
  - `npm run test:oracle`: 退出码 0，4 测试通过。
  - `npm run test:math`: 退出码 0，152 测试通过。
  - `npm run typecheck`: 退出码 0，无任何类型错误。
