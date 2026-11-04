# GainFront P010-T016 性能实测报告 (Benchmark Report)

- 测试时间: 2026-11-04T04:16:21.653Z
- 测试平台 OS: Linux x86_64 Ubuntu 24.04.5 LTS
- CPU 规格: AMD EPYC 9D25 126-Core Processor (VM environment)
- Node.js 版本: v24.22.1
- 浏览器: Chromium (Playwright headless)
- Windows 平台状态: **NOT_TESTED**（按契约明确标注，未在真实 Windows 运行测试）

## 性能三项实测数值与门槛对照表

| 序号 | 评测项 | 项目书 §11 门槛 | 实测数值 | 判定结果 | 测试方法与音频源 |
|---|---|---|---|---|---|
| 1 | 8秒 mono 完整分析用时 | ≤ 5000 ms (5.0s) | **239 ms** (0.239s) | **PASS** | 预设 GF-B (48kHz mono 8s, 384,000帧)，经过完整 K-weighting、双门限、4×True-Peak 与 481点格点求解 |
| 2 | 30秒 stereo 外部导入完整分析用时 | ≤ 25000 ms (25.0s) | **836 ms** (0.836s) | **PASS** | 独立生成 30秒双声道 48kHz WAV 文件 (1,440,000帧)，外部导入流程经由 SHA-256 校验重绑定及 Dedicated Worker 运算 |
| 3 | 页面主线程输入响应用时 | ≤ 150 ms | **14.50 ms** (平均 12.66 ms) | **PASS** | 键盘/滑块输入事件派发到 requestAnimationFrame 界面重绘响应 |

## 离线运行契约断言

- 网络隔离模式: Playwright `context.setOffline(true)` 全程断网
- 外网请求监听: 零外网请求 (`externalRequests = []`)
- 详见 `offline-network-log.json` 与 `offline-console-log.json`
