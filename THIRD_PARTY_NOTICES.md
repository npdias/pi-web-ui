# Third-party notices

## DeepSeek Harness trajectory UI

Observe Trajectory work derives from DeepSeek Harness trajectory UI code.

- Repository: https://github.com/deepseek-ai/DeepSeek-Harness
- Donor package: `packages/client/ui-trajectory`
- Pinned donor commit: `0a53fb55bea101816fa226bb964ae2bed71c343b`
- Pinned donor source: https://github.com/deepseek-ai/DeepSeek-Harness/tree/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/client/ui-trajectory
- License: MIT
- License source: https://github.com/deepseek-ai/DeepSeek-Harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/LICENSE
- Copyright: Copyright (c) 2026 DeepSeek

Task 3 copied or substantially adapted these donor files:

- `src/client/trajectory-record.ts` -> `web/src/observe/trajectory/record.ts`
- `src/client/layout.ts` -> `web/src/observe/trajectory/project.ts` (Turn/Step grouping and exact tool lifecycle pairing only; telemetry projection is rewritten around normalized envelopes)
- `src/client/trajectory-search-index.ts` -> `web/src/observe/trajectory/search-index.ts`
- `src/client/trajectory-virtual-rows.ts` -> `web/src/observe/trajectory/virtual-rows.ts`

Task 3 test adaptations:

- `tests/layout.client.spec.tsx` -> `tests/unit/trajectory-project.test.ts`
- `tests/virtual-rows.client.spec.ts` -> `tests/unit/trajectory-virtual-rows.test.ts`
- Search coverage in `tests/unit/trajectory-search.test.ts` is target-native coverage of the adapted `src/client/trajectory-search-index.ts`; the donor has no standalone search-index test.

Later planned adaptation boundary:

- `src/client/timeline.ts` -> Pi-owned timeline projection code
- `src/client/TrajectoryTimeline.tsx` plus `src/client/TrajectoryTimeline.module.css` -> `web/src/observe/trajectory/TrajectoryTimeline.tsx` plus `web/src/observe/trajectory/TrajectoryTimeline.css`
- `src/client/TrajectoryCell.tsx`, `src/client/TrajectoryTurn.tsx`, `src/client/TrajectoryTurnHeader.tsx`, selected `src/client/TrajectoryTable.tsx` structure, toolbar structure, CSS tokens -> Pi-owned ledger, inspector, toolbar, responsive styles

Cordis registration, DSH session projections, DSH conversation bindings, request types, locale framework, attachment authorization, view-ring integration remain outside adaptation boundary.

### MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
