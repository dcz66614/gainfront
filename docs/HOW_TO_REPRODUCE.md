# 声限图 GainFront 从源码复现指南 (How to Reproduce)

本文档提供从源码干净环境完全复现 GainFront 静态构建、离线测试、数学回归及端到端自动化测试的标准操作流程与环境版本记录。

---

## 一、验证环境版本基线 (Environment Baseline)

| 类别 | 规格与版本 | 备注说明 |
|---|---|---|
| **操作系统 (OS)** | `Linux htch-runtime 7.0.0-39-generic x86_64` (Ubuntu 24.04.5 LTS) | 标准 64 位 Linux VM 环境 |
| **中央处理器 (CPU)** | `AMD EPYC 9D25 126-Core Processor` (4 vCPUs) | 物理宿主提供 4 虚拟核心 |
| **Node.js** | `v24.22.1` | 生产级 LTS 运行时 |
| **npm** | `10.9.4` | 伴随 Node.js 发行包管理器 |
| **TypeScript** | `5.8.2` | 静态类型核验工具链 |
| **Vite** | `7.3.7` | 前端打包与静态预览工具 |
| **Vitest** | `4.1.12` | 核心数学单元测试与 Oracle 对照测试 |
| **Playwright** | `1.64.1` (Chromium headless) | 离线、无障碍与端到端自动化 |
| **React / React-DOM** | `19.0.0` | 前端响应式界面组件库 |
| **Windows 平台状态** | **NOT_TESTED** | 未在真实 Windows 环境运行，严禁暗示已验证 |

---

## 二、从源码复现的标准步骤 (Step-by-Step Instructions)

### 步骤 1：获取源码与安装依赖

进入项目根目录下的源码目录 `03_source/`，通过 `package-lock.json` 安装完全锁定的纯净依赖：

```bash
cd 03_source
npm ci
```

> [!NOTE]
> 在空间有限的容器或虚拟化环境中运行时，建议设置本地临时目录：
> ```bash
> mkdir -p .tmp
> export TMPDIR="$(pwd)/.tmp"
> ```

### 步骤 2：静态类型检查 (Type Check)

运行 TypeScript 类型检查，确保零类型错误与代码符号完整性：

```bash
npm run typecheck
```

- 预期退出码: `0`
- 预期输出: 编译通过，无任何类型报错。

### 步骤 3：核心数学回归测试 (Math Suite)

运行针对 BS.1770-4 算法、Biquad 滤波器系数、多阶段门限、4× True-Peak 与 481 格点求解器的全量数学测试：

```bash
npm run test:math
```

- 预期退出码: `0`
- 预期测试数: 10 个测试文件（约 147 项断言），全部 `PASS`。

### 步骤 4：全量单元与组件测试 (Full Vitest Suite)

运行包括 Oracle（FFmpeg ebur128 对齐）、Worker 协议状态机、Session 序列化与 UI 映射的全量测试套件：

```bash
npm test
```

- 预期退出码: `0`
- 预期测试数: 14 个测试文件（232 项测试），全部 `PASS`。

### 步骤 5：生产包构建 (Production Build)

执行生产级静态构建与前端资源打包：

```bash
npm run build
```

- 预期退出码: `0`
- 预期产物: `dist/index.html`、`dist/assets/*.js`、`dist/assets/*.css` 静态资源目录。

### 步骤 6：端到端与离线/无障碍测试 (Playwright E2E Suite)

运行包括断网全流程（`offline.spec.ts`）、无障碍与 360px 窄屏适配（`a11y.spec.ts`）、竞态与会话导入导出的端到端测试：

```bash
npm run test:e2e
```

- 预期退出码: `0`
- 预期测试数: 11 项 E2E 测试用例，全部 `PASS`。
- 测试过程中将自动收集性能数据并输出至 `evidence/benchmark/`，截图保存至 `evidence/screenshots/`。

---

## 三、一键全量验收命令 (All-in-One Verification)

可使用以下组合命令一次性完成全流程终审验证：

```bash
export TMPDIR="$(pwd)/.tmp" && \
npm run typecheck && \
npm run test:math && \
npm test && \
npm run build && \
npm run test:e2e
```

全部真实退出码应为 `0`，表明系统在离线、性能、数学严密性与无障碍方面均完全达到验收标准。
