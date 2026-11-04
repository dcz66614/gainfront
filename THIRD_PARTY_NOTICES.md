# Third-Party Notices and Attribution

This project, **P010 声限图 GainFront**, incorporates open-source third-party dependencies and relies on publicly published audio engineering standards. This document provides notice of copyright holders, licenses, and citation boundaries.

---

## 1. Direct Software Dependencies

The following open-source software libraries and packages are utilized in the construction, development, and runtime of GainFront:

### 1.1 React & React DOM
- **Package**: `react`, `react-dom`
- **Version**: `^19.0.0`
- **License**: MIT
- **Copyright**: Copyright (c) Meta Platforms, Inc. and affiliates.
- **Notice**:
  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction...

### 1.2 Vite & Vite React Plugin
- **Package**: `vite`, `@vitejs/plugin-react`
- **Version**: `7.3.7` / `^5.1.4`
- **License**: MIT
- **Copyright**: Copyright (c) 2019-present Evan You & Vite Contributors

### 1.3 Vitest
- **Package**: `vitest`
- **Version**: `4.1.12`
- **License**: MIT
- **Copyright**: Copyright (c) 2021-present Anthony Fu, Matias Capeletto, and Vitest Contributors

### 1.4 Microsoft Playwright
- **Package**: `@playwright/test`
- **Version**: `^1.64.1`
- **License**: Apache License, Version 2.0
- **Copyright**: Copyright (c) Microsoft Corporation
- **Notice**: Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

### 1.5 TypeScript
- **Package**: `typescript`
- **Version**: `~5.8.2`
- **License**: Apache License, Version 2.0
- **Copyright**: Copyright (c) Microsoft Corporation
- **Notice**: Licensed under the Apache License, Version 2.0.

### 1.6 DefinitelyTyped Type Definitions
- **Package**: `@types/node`, `@types/react`, `@types/react-dom`
- **Version**: `^24.19.2` / `^19.0.0`
- **License**: MIT
- **Copyright**: Copyright (c) Microsoft Corporation and DefinitelyTyped contributors.

---

## 2. Standards, Reference Specifications & Citation Boundaries

The mathematical logic implemented in `src/core/` and tested against independent oracles references publicly available standard engineering specifications and academic publications:

1. **ITU-R BS.1770-5 (2023)**: *Algorithms to measure audio programme loudness and true-peak audio level*. International Telecommunication Union, Geneva, Switzerland. URL: https://www.itu.int/rec/R-REC-BS.1770-5-202311-I
   - *Citation Scope*: Biquad K-weighting filter coefficients, two-stage gating thresholds (-70 LKFS absolute, -10 LU relative), and 4× oversampling windowed sinc true-peak approximation principle.
   - *Notice*: This implementation is an educational and engineering visualization tool; it is **NOT** formally certified by the ITU. Standards text, schemas, and protected diagrams are NOT reproduced verbatim.

2. **EBU Recommendation R128 (2020)**: *Loudness normalisation and permitted maximum level of audio signals*. European Broadcasting Union, Geneva, Switzerland. URL: https://tech.ebu.ch/publications/r128
   - *Citation Scope*: -23.0 LUFS target reference and -1.0 dBTP maximum true-peak recommendation thresholds.

3. **FFmpeg / libavfilter `ebur128`**:
   - URL: https://ffmpeg.org / https://github.com/FFmpeg/FFmpeg
   - *Citation Scope*: Used solely as an external, independent reference oracle during development testing (`tests/oracle/ebur128.test.ts`) to cross-validate integrated loudness on synthetic fixtures. No FFmpeg binary code or GPL/LGPL compiled assets are bundled into GainFront distribution packages.
