# ArcAsha (Akasha-OS)

> **AI를 위한 운영체제 — 모듈형 추론과 런타임 지능**

ArcAsha는 **모델이 아닙니다**. 신경망 모델 **위에서 동작하는 OS**입니다 — 추론을 OS 수준에서 **구성·제어·측정·설명**합니다.

- 모델은 **수정하지 않습니다**.
- 모델 **외부에 OS 레이어**를 두고 라우팅·메모리·추론·스케줄링·자기 개선을 관리합니다.

> **핵심 연구 질문**: 모델을 키우는 대신, 지능을 OS 수준에서 구성·제어·측정하고 재현 가능하게 증명할 수 있는가?

---

## 🎯 왜 ArcAsha인가

GPT / MoE는 모든 추론을 신경망 **내부**(블랙박스)에서 수행합니다.

ArcAsha는 추론을 모델 **외부**로 꺼냅니다:

```
Task → Compiler → AILSM IR → Kernel → Executive → Hypothesis → Search → Experts → Memory
```

- **AILSM / AILSA**: AI 전용 중간 표현과 명령어 집합
- **AVM**: AI 가상 메모리(필요한 컨텍스트만 수요 페이징으로 공급)
- **Executive / Meta Executive**: 추론 전체를 지휘하고 관측에서 자신의 정책을 학습
- **Intelligence Attachments**: 필요할 때만 로드하는 고급 지능(선택적 커널 모듈)

---

## 🏗️ 3계층 아키텍처

```
Layer 3  Intelligence Attachments(Reflection / Debate / Planning / Search / Creativity / Simulation / Coding)
Layer 2  Executive Runtime(Executive / Meta Executive / Expert Evolution / Intelligence Scheduler)
Layer 1  Fast Runtime(Kernel / AVM / Expert Runtime / ODAR / Device Tree) — 항상 고속
```

**Fast와 Deliberation 분리**: Fast는 실시간 제어를 유지(로봇 30.3fps), Deliberation은 필요할 때만 로드(연구·장시간 추론).

## ✨ 주요 기능

- **AVM**: 가상 메모리로서의 컨텍스트 관리(실 API 검증·장문 컨텍스트: 토큰 96.5% 감소·정확도 100% — 기존 4.10x / −77%는 **분리 전** 측정)
- **Executive / Meta Executive**: 탐색을 지휘하고 결과에서 정책을 학습
- **Expert Evolution**: 전문가가 객관적 기준(건강도·중복·활용률)으로 분열·통합·은퇴
- **Thinking Modes**: Fast / Auto / Deep / Custom — 같은 OS, 다른 파이프라인
- **설명 가능**: **Decision Explanation**(왜 이 구성인지) / **Decision Replay**(단계 재생) / **OS Policy Learning**(결정을 학습 데이터로)
- **검증**: Simulation과 Real Device 분리; 외부 벤치: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench(Qwen1.5B 행은**분리 전** simulation 측정; 실 API 검증은 아래 Phase 4)

---

## 🚀 퀵스타트

```bash
npm install arcasha
arcasha benchmark   # 전체 벤치(Simulation) + Decision Explanation + reports/
arcasha replay      # 「왜 이 답변인가」를 단계 재생
arcasha policy      # OS 정책 학습 데모
```

리포지토리에서 실행:

```bash
cd akasha-master
npm install
npm run ailsm:selftest          # 72개 결정론 테스트
npm run benchmark               # 전체 벤치 + reports/(json/csv/md)
npx tsx examples/quickstart.ts  # 5분 투어
```

---

## 💬 AI 어시스턴트(리치 Chat WebUI・장기 기억 포함)

전문 지식 없이 일상 작업에 바로 쓸 수 있는 **AI 어시스턴트**(Hermes Agent / DeepSeek Web UI 스타일・제로 의존성).
멀티 모델(`deepseek-v4-flash` / `deepseek-v4-pro`)을 작업 분류로 자동 라우팅하고, **장기 기억**(사용자 정보・취향・
대화 스레드)을 JSON으로 영속화합니다(재시작 후에도 유지).

```bash
cd akasha-master
npm run assistant          # http://localhost:4781 에서 실행
npm run assistant:test     # 장기 기억 + 기억 추출 규칙 단위 테스트(21 tests)
```

- **캐주얼 모드(기본)**: 자연어로 일상 작업(상담・글쓰기・요약・아이디어 등).
  자기소개(「제 이름은〜」「〜좋아함/싫어함」)는 자동으로 기억되어 이후 대화에서 활용
- **전문가 모드**: 우측 상단 전환으로 `/help` `/memory` `/remember` `/forget` `/pin` 등 슬래시 명령 사용 가능
- **OpenAI 호환 API**: `POST /v1/chat/completions`(baseURL = `http://localhost:4781/v1`)
  를 Cursor 등 외부 도구에서 그대로 사용 가능. `/v1/models`로 모델 공개
- **장기 기억 저장 위치**: `~/.arcasha/assistant-memory.json`(`ARCASHA_MEMORY_DIR`로 변경 가능)
- 구현: `src/arcasha/assistant/`(server / long-term-memory / remember / ui.html)

---

## 📁 리포지토리 구조

```
akasha-master/        핵심 구현(TypeScript / AILSA / AILSM / Kernel / AVM / Executive / Attachments)
akasha-link/          Project A: Akasha-Link (분산 추론 / 텐서 전송)
  ├── client-web/     웹 클라이언트(WebGPU 추론)
  └── kernel-native/  네이티브 커널 프로토타입(Rust)
examples/             플러그인 예제(code / math)
AI_*.md               스펙 문서
```

## 📚 문서

`MASTER_SPEC.md`(전체 비전) / `ARCASHA_V2_SPEC.md`(v2 설계 v0.36) / `AI_REASONING.md`(추론 런타임) / `AI_ATTACHMENTS.md`(플러그인 레이어) / `AI_VALIDATION.md`(검증·설명) / `AI_VIRTUAL_MEMORY.md`(AVM) / `PAPER_OUTLINE.md`(논문) / `CHANGELOG.md`(이력)

## 🤖 SWE-bench 실측 문제 검증(코딩 에이전트)

Phase 4에 이어 ArcAsha의 소프트웨어 엔지니어링 에이전트(`src/arcasha/swe/`・툴 루프 구현)가 실제 API로 SWE-bench Lite 인스턴스를 해결했습니다. 모든 수치는 실측입니다.

- **대상**: `princeton-nlp/SWE-bench_Lite`(test split 300문제)에서 선정한 **sympy/sympy 3문제**(순수 Python・의존성 제로・로컬 평가 가능) — `24213`(차원 등가 판정)/ `23117`(`Array([])`)/ `24152`(`TensorProduct.expand`)
- **모델**: `deepseek-v4-flash`(실제 API・`temperature=0`)/ 환경: macOS / Python 3.13.2 / pytest 9.1.1 / sympy를 base_commit에서 editable install
- **평가**: checkout `base_commit` → 에이전트가 **소스만** 수정 → 작업 트리 복원 → gold `test_patch` 적용 → 에이전트 패치 적용 → pytest로 `FAIL_TO_PASS`/`PASS_TO_PASS` 실행 → F2P가 모두 pass하면 resolved. 함수명만 있는 테스트는 `파일::함수`로 자동 해석
- **결과: 3/3 해결(100%)** — model calls 26/29/11・tools 31/44/13・93s/206s/71s(문제당)
- 정직한 주의: LLM은 확률적(`23117`은 “불완전 응답”으로 1회 실패 → 재실행으로 해결. `22005`는 2021년 base_commit이 Python 3.13의 `distutils` 제거와 비호환되어 평가 불가); 선정 3문제라 통계적 해결률 추정이 아님; **이번 실행은 토큰 사용량을 기록하지 않음**(`agent.ts`/`eval.ts`에 usage 집계 추가. 이후 실행은 `reports/swebench/swebench-results.json`에 기록)
- 평가 하네스(코드): `src/arcasha/swe/`; 커밋된 결과: `reports/swebench/swebench-results.json`

### 일반 DeepSeek vs arcasha(1문제 대조 비교, 2026-09)

에이전트/도구 계층이 **순수 모델 호출**에 비해 무엇을 더하는지 정량화하기 위해,
**동일한 1문제**(`sympy__sympy-24213`)에서 아래를 비교했습니다.

- **일반 DeepSeek** — 순수 `deepseek-v4-flash`(thinking ON・`reasoning_effort=high`)에
  이슈 텍스트 **+ 대상 파일 발췌**를 주고 unified diff를 한 번에 손으로 쓰게 함. 3회 시도.
- **arcasha** — 위에서 설명한 SWE 에이전트(도구 루프) 그대로.

숫자는 모두 실측 API 기준. 비용은 DeepSeek 공식 `deepseek-v4-flash` 단가
(off-peak: 입력 $0.22 / 출력 $0.66 per 1M)로 산정. 상세·원시 데이터:
`reports/swebench/compare-deepseek-vs-arcasha.{md,json}`.

| 지표 | 일반 DeepSeek(3회) | arcasha |
|---|---:|---:|
| 해결 | ❌ 0/3 | ✅ 1/1 |
| 입력 토큰 | 3,756 | 726,877 |
| 출력 토큰 | 39,428 | 14,532 |
| 총 토큰 | 43,184 | 741,409 |
| 시간 | 267 s(3회 합계) | 127 s |
| 비용(off-peak, $) | $0.027 | $0.170 |

**핵심 발견**: 일반 DeepSeek는 매회 올바른 수정 내용(gold 패치와 동일한
`equivalent_dims` 검사)을 찾아냈습니다. 그러나 unified diff를 **손으로 작성**해야 하므로
3회 모두 hunk 헤더 줄 수 오산·끝 컨텍스트 누락이 발생해 `git apply`가 패치를 거부(0/3).
에이전트는 `edit_file`/`write_file`로 소스를 **직접 편집**하므로 diff는 git이 생성
(손으로 hunk 계산 불필요) → 항상 적용 가능 → 해결. 즉 SWE-bench를 풀려면 “수정 내용을
아는 것”뿐 아니라 **실제 파일에 적용할 도구**가 필요하다는 것이 이 1문제 비교의 결론입니다.

- 정직한 주의: 확률적(별도 1회 실행에서 1/1 해결도 확인. 원샷 diff 생성은 가능하나 불안정)・
  1문제만으로 통계적 추정이 아님.

## 🧪 상태

- **v1.0 출시** — AI OS 1세대(ISA/IR/Kernel/AVM → 실기 → Reasoning → Executive/Meta → Attachments → Validation)
- **v1.1** — Decision Replay, 실기 벤치 계획(Mac / iPhone 15 Pro / iPad M4)
- **Phase 4 실 API 검증(2026-09)** — 컴포넌트 절제(Baseline/AVM/Executive/Full·50문항 × 3) + 장문 AVM(96.5% 토큰 감소·정확도 100%) + Executive 병목(이중 호출 수정: +348ms → +37ms·PR #37 실측)
- selftest [1]-[72] 전부 통과 / golden 30 / AILSA selftest / build + dist 검증 완료

## 🔬 연구적 위치

ArcAsha는 「더 큰 모델」이 아닙니다:

> **OS 수준에서 AI 지능을 구성·제어·측정하는 재현 가능한 실험 플랫폼.**

가장 새로운 점: OS가 왜 Reflection / Planning / Debate을 사용했는지 **설명**할 수 있고(Decision Explanation), 결정 과정 전체를 **재생**할 수 있으며(Decision Replay), 자신의 결정에서 **학습**합니다(OS Policy Learning) — Transformer 사전학습과 직교하는 학습 축.

## 라이선스
MIT — `LICENSE` 참조.
