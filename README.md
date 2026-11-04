# P010 声限图 GainFront

> **短音频恒定增益的响度—真峰值可行域与失败见证实验室**
> A web-based loudness-truepeak feasibility frontier and linear-gain failure witness laboratory for short audio clips.

---

## 一、项目简介 (Overview)

**声限图 GainFront** 是一款面向短音频（1–30 秒，48 kHz 16-bit 单/双声道 WAV）的交互式响度与真峰值可行域分析实验室。

在广播与流媒体正规化流程中，用户常困惑于为何简单调整恒定增益（Linear Gain）无法同时满足目标集成响度（如 -23.0 LUFS）与真峰值上限（如 -1.0 dBTP）。GainFront 在纯浏览器本地环境中，通过 Dedicated Web Worker 执行 ITU-R BS.1770-5 差分加权滤波、双阶段门限集成响度测量以及 4× 过采样 sinc 插值估计真峰值（Estimated dBTP）。通过在 `[-24.0, +24.0] dB` 范围内以 0.1 dB 步长重算双阶段门限，GainFront 构建出离散响度可行域、标记最佳增益 $g_{\text{Best}}$ 与目标增益 $g_{\text{Target}}$，并在无法可行时给出明确的因果证词（例如「欲达目标响度需增益 +5.0 dB，但这将导致真峰值超标 +3.2 dBTP」），直观展示恒定增益的物理极限。

---

## 二、2 分钟快速演示路径 (2-Minute Demo Tour)

进入本地开发服务器或静态页面后，可依以下标准路径体验核心功能：

1. **观察预设 GF-A（峰值陷阱 / 失败见证）**：
   - 默认载入预设 **GF-A (Peak Trap)**。
   - 观察主结论卡展示状态 `GAIN_BLOCKED`（不可行）。
   - 查看声限图下方见证语句：清晰揭示「要达到 -23.0 LUFS 目标增益 $g_{\text{Target}}$ 需要增益，但这将导致峰值突破上限 $C$」。
   - 点击声限图中的顶点查看 4× 采样点与 33-tap 邻域样点分布。
2. **微调约束或切换至预设 GF-B（可行解示范）**：
   - 调节控制面板的目标响度 $T$ 或真峰值上限 $C$（步长 0.5），观察可行区间动态收缩或展开；
   - 或点击预设切换为 **GF-B (Safe Gain)**：Worker 立即重新分析，结论卡状态更新为 `GAIN_FEASIBLE`，绿色高亮显示可行增益区间，底栏游标指示最优可行增益 $g_{\text{Best}}$。
3. **导出证据 JSON 与外部 WAV 绑定验证**：
   - 在底栏「导入与导出」模块点击 **导出证据 JSON**，下载包含完整参数、测量指标与可行域散点的 `.json` 证据文件（会话不含用户音频字节）。
   - 尝试篡改 JSON 规格版本或 SHA-256 再次导入，系统将立即拦截并提示拒绝；导入合法预设会话则无损恢复。
   - 选择本地外部 48kHz WAV 文件，系统将使用 WebCrypto 严格校验 SHA-256 哈希重绑定，未验证前绝对不伪装结果。

---

## 三、离线与隐私声明 (Offline & Privacy Declaration)

- **100% 本地离线执行**：GainFront 所有 DSP 计算、波形解析、门限分析与图形渲染全部运行在浏览器前端环境（主线程 + Web Worker）。
- **零网络请求**：运行期间除加载初始本地静态静态资源外，**绝对不向任何外部服务器发送 HTTP/WebSocket 网络请求**。
- **无远程字体与遥测**：不引入任何 CDN 远程字体、分析脚本或追踪探针。
- **零本地持久化隐私泄漏**：不向 `localStorage`、`sessionStorage` 或 `indexedDB` 写入用户音频数据；导出的会话 JSON 仅记录元数据与量化指标，绝不泄露原始音频采样。

---

## 四、免责声明与技术局限 (Disclaimer & Limitations)

1. **4× 近似非广播认证**：真峰值（True-Peak）检测采用 4× 过采样、33-tap 对称余弦窗化 sinc 插值核，仅作为**估计真峰值（Estimated dBTP）**，不可替代标准硬件级或全规格 ITU-R BS.1770-5 / EBU R128 认证广播测量设备。推荐约束以安全裕量 `margin = 0.3 dB` 标识，不作法律或工业绝对安全保证。
2. **短音频边界**：本系统作为短音频分析实验室，严格限制输入为 1 至 30 秒、48,000 Hz、16-bit 线性 PCM WAV 文件，文件大小上限 8 MiB。
3. **操作系统实测范围**：本项目全量自动化测试与构建在 Linux 6.6+ x86_64 环境下完成。**Windows 环境标为 NOT_TESTED**，未在物理 Windows 宿主环境进行自动化回归。

---

## 五、环境要求与复现命令 (Reproduction Guide)

### 5.1 环境基准

- **Node.js**: `v24.x LTS` (实测 `v24.13.0` / `v24.22.1`)
- **npm**: `10.x` / `11.x`
- **TypeScript**: `5.8.x`
- **Vite**: `7.3.7`
- **Vitest**: `4.1.12`
- **Playwright**: `1.64.x`

### 5.2 常用开发与构建命令

```bash
# 1. 干净安装全部锁定依赖
npm ci

# 2. 设置本地临时目录（避免小容量 /tmp tmpfs 溢出）
mkdir -p .tmp
export TMPDIR="$(pwd)/.tmp"

# 3. 静态类型检查
npm run typecheck

# 4. 运行全量 Vitest 单元与集成测试（包含 9 组核心数学与 1 组独立 Oracle 对拍）
npm test

# 5. 运行独立数学测试集
npm run test:math

# 6. 运行独立 FFmpeg ebur128 Oracle 对拍测试
npm run test:oracle

# 7. 生产环境静态打包构建
npm run build

# 8. 运行 Playwright 离线、竞态、无障碍与 E2E 完整套件
npm run test:e2e

# 9. 本地预览静态站点
npm run preview

# 10. 官方一键构建交付包（T018 打包与校验脚本）
npm run release:bundle
```

---

## 六、许可协议与第三方开源声明 (Licensing)

- 本项目自有原创源代码采用 [MIT License](LICENSE) 授权。
- 依赖的第三方开源组件（React, Vite, Vitest, Playwright, TypeScript 等）遵循各自开源许可证，详细清单与标准文献引用边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
