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

ArcAsha의 소프트웨어 엔지니어링 에이전트(`akasha-master/src/arcasha/swe/`)가 실제 API(`deepseek-v4-flash`・`temperature=0`)로 SWE-bench Lite 인스턴스를 해결했습니다. 상세: `akasha-master/README.md`.

- **SWE-bench Lite(test split)에서 선정한 sympy 3문제**: `24213`(차원 등가 판정)/ `23117`(`Array([])`)/ `24152`(`TensorProduct.expand`)
- **결과: 3/3 해결(100%)** — 모델 호출 26/29/11회・도구 31/44/13회・소요 93s/206s/71s(문제당). 에이전트는 **소스만** 수정하고 pytest로 검증. 테스트 파일은 쓰기 금지(평가 시 gold `test_patch` 자동 적용)
- 정직한 주의: LLM은 확률적(1문제는 재실행으로 해결). 선정 3문제라 통계적 해결률 추정이 아님. **이번 실행은 토큰 사용량을 기록하지 않음**(평가 프레임워크에 usage 집계 추가됨. 이후 실행은 `akasha-master/reports/swebench/swebench-results.json`에 기록)

### 일반 DeepSeek vs arcasha(1문제 대조 비교, 2026-09)

에이전트/도구 계층의 가치를 정량화하기 위해 **동일한 1문제** `sympy__sympy-24213`에서
“순수 `deepseek-v4-flash`(문제+파일 발췌・원샷 unified diff)”와 “arcasha 에이전트”를 비교.
실측 API 기준. 상세: `akasha-master/reports/swebench/compare-deepseek-vs-arcasha.md`。

- **일반 DeepSeek: 0/3 해결** — 매회 gold와 동일한 올바른 수정을 찾지만, 손으로 쓴 unified
  diff의 hunk 줄 수 오류/끝 컨텍스트 누락으로 `git apply`가 매번 거부(43,184 tokens / $0.027
  off-peak / 267 s)
- **arcasha: 1/1 해결** — `edit_file`로 파일을 직접 수정해 diff는 git이 생성(손 계산 불필요) →
  항상 적용 가능(741,409 tokens / $0.170 off-peak / 127 s)
- 결론: SWE-bench를 풀려면 “수정 내용을 아는 것”뿐 아니라 **실제 파일에 적용할 도구**가 필요.
  원샷 diff 생성은 가능하나 불안정

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
