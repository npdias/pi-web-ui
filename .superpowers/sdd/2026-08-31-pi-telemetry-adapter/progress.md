# Pi telemetry adapter progress

| Task | Status | Evidence |
| --- | --- | --- |
| Baseline | complete | Typecheck, 228 Vitest tests, production build |
| Task 1: socket client | approved | `3539546`, `904dd32`, `7900ad8`; focused 23/23; full Vitest 251/251; independent review clean |
| Task 2: Pi event mapper | approved | `07b3861`, `d219851`, `98eaeca`, `dee4f07`, `af86aac`; focused mapper suite; full Vitest 310/310; typecheck/build/protocol pass |
| Task 3: conversation integration | review-approved; QA open | Architecture reset reverts through `647fb10`; minimal implementation `04f3f8b`; health/systemd review fix `f095187`; focused zero-token integration pass; protocol/typecheck/build pass; Vitest 313/313; smoke 32/33 with existing `settings-test` `skill re-enabled` failure; independent review found no Critical/Important issues |
| Task 4: diagnostic fixtures | approved | `f6eb178`, `e7c84db`, `c8d29e4`, `5c2c69a`, `3b03745`; five scenarios normalized; real LF queue accepted 21/21; focused/full/typecheck/protocol/build passed; smoke 32/33 with existing `settings-test` failure |
| Final review fixes 2-4 | review-verified; whole-adapter review open | `940b098`; forced reset terminals, monotonic absolute 1 s ACK deadline, and 16 MiB UTF-8 queue cap; focused 96/96; full 324/324; integration/scenarios/typecheck/protocol/build pass; final smoke 32/33 with only known `settings-test` failure |
| Final review finding 1 | implemented; full gates and re-review pending | `OPS-034` owner approval; effective prompt plus sorted active tool schemas supplied in-process at run/turn start; exact socket-line sentinel privacy, hash suppression/change, capture-failure isolation, and mapper/session replacement integration pass; server typecheck and focused adapter/scenarios pass |
