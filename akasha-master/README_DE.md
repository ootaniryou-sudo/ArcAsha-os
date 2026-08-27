# ArcAsha (Akasha-OS)

> **Ein KI-Betriebssystem — modulares Denken und Laufzeit-Intelligenz**

ArcAsha ist **kein Modell**. Es ist ein **Betriebssystem, das auf neuronalen Modellen läuft** — es konfiguriert, steuert, misst und **erklärt** KI-Denken auf OS-Ebene.

- Wir **verändern das Modell nicht**.
- Wir legen eine **OS-Schicht außerhalb des Modells** an, um Routing, Speicher, Denken, Scheduling und Selbstverbesserung zu verwalten.

> **Zentrale Forschungsfrage**: Können wir Intelligenz auf OS-Ebene komponieren, steuern und messen — und reproduzierbar beweisen — statt das Modell zu vergrößern?

---

## 🎯 Warum ArcAsha

GPT / MoE führen alles Denken **innerhalb** des neuronalen Netzes (Blackbox) aus.

ArcAsha verlagert das Denken **nach außen**:

```
Task → Compiler → AILSM IR → Kernel → Executive → Hypothesis → Search → Experts → Memory
```

- **AILSM / AILSA** : KI-spezifische IR und ISA (die „Maschinensprache" des Denkens)
- **AVM** : KI-Virtual Memory (nur der benötigte Kontext wird per Demand-Paging geladen)
- **Executive / Meta Executive** : befehligen das gesamte Denken und lernen ihre eigene Politik
- **Intelligence Attachments** : erweiterte Intelligenz, nur bei Bedarf geladen (wie optionale Kernel-Module)

---

## 🏗️ Architektur (3 Ebenen)

```
Layer 3  Intelligence Attachments (Reflection / Debate / Planning / Search / Creativity / Simulation / Coding)
Layer 2  Executive Runtime (Executive / Meta Executive / Expert Evolution / Intelligence Scheduler)
Layer 1  Fast Runtime (Kernel / AVM / Expert Runtime / ODAR / Device Tree) — immer schnell
```

**Fast vs. Deliberation**: Fast hält Echtzeitsteuerung (Roboter 30,3 fps), Deliberation wird nur bei Bedarf geladen (Forschung / langes Denken).

## ✨ Hauptfunktionen

- **AVM**: Kontext als bedarfsweise ausgelagerter virtueller Speicher (4,10x, −77% Tokens vs. Voll-Lesen)
- **Executive / Meta Executive**: befehligen die Suche, lernen ihre Politik aus Ergebnissen
- **Expert Evolution**: Experten teilen/vereinigen/gehen in den Ruhestand nach objektiven Kriterien (Gesundheit, Überlappung, Auslastung)
- **Thinking Modes**: Fast / Auto / Deep / Custom — gleiches OS, andere Pipeline
- **Erklärbar**: **Decision Explanation** (warum diese Konfiguration), **Decision Replay** (Schritt-für-Schritt), **OS Policy Learning** (Entscheidungen werden Trainingsdaten)
- **Validierung**: Simulation und Real Device getrennt; externe Benchmarks: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench

---

## 🚀 Schnellstart

```bash
npm install arcasha
arcasha benchmark   # Kompletter Benchmark (Simulation) + Decision Explanation + reports/
arcasha replay      # „Warum diese Antwort?" — Schritt-für-Schritt-Wiedergabe
arcasha policy      # OS-Policy-Learning-Demo
```

Aus dem Repository:

```bash
cd akasha-master
npm install
npm run ailsm:selftest          # 72 deterministische Tests
npm run benchmark               # Kompletter Benchmark + reports/ (json/csv/md)
npx tsx examples/quickstart.ts  # 5-Minuten-Tour
```

---

## 📁 Repository-Struktur

```
akasha-master/        Kernimplementierung (TypeScript / AILSA / AILSM / Kernel / AVM / Executive / Attachments)
akasha-link/          Project A: Akasha-Link (verteilte Inferenz / Tensortransport)
  ├── client-web/     Web-Client (WebGPU-Inferenz)
  └── kernel-native/  Nativer Kernel-Prototyp (Rust)
examples/             Plugin-Beispiele (code / math)
AI_*.md               Spezifikationen
```

## 📚 Dokumentation

`MASTER_SPEC.md` (Vision) / `ARCASHA_V2_SPEC.md` (v2-Spez v0.36) / `AI_REASONING.md` (Denk-Runtime) / `AI_ATTACHMENTS.md` (Plugin-Ebene) / `AI_VALIDATION.md` (Validierung & Erklärung) / `AI_VIRTUAL_MEMORY.md` (AVM) / `PAPER_OUTLINE.md` (Paper) / `CHANGELOG.md` (Verlauf)

## 🧪 Status

- **v1.0 veröffentlicht** — erste KI-OS-Generation (ISA/IR/Kernel/AVM → echte Geräte → Reasoning → Executive/Meta → Attachments → Validation)
- **v1.1** — Decision Replay, Real-Device-Benchmark-Plan (Mac / iPhone 15 Pro / iPad M4)
- selftest [1]-[72] alle bestanden / golden 30 / AILSA selftest / build + dist verifiziert

## 🔬 Forschungspositionierung

ArcAsha ist nicht „ein größeres Modell":

> **Eine reproduzierbare experimentelle Plattform, um KI-Intelligenz auf OS-Ebene zu komponieren, zu steuern und zu messen.**

Der neuartigste Punkt: Das OS kann **erklären, warum** Reflection / Planning / Debate verwendet wurden (Decision Explanation), den gesamten Entscheidungsprozess **abspielen** (Decision Replay) und aus eigenen Entscheidungen **lernen** (OS Policy Learning) — eine zu Transformer-Pretraining orthogonale Lernachse.

## Lizenz
MIT — siehe `LICENSE`.
