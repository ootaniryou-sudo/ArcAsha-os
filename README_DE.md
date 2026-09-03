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

- **AVM**: Kontext als bedarfsweise ausgelagerter virtueller Speicher (per realer API validiert – Langtext-Kontext: **96,5 % Token-Reduktion bei 100 % Genauigkeit** — die alte 4,10x / −77 %-Angabe ist eine **Messung vor der Trennung**)
- **Executive / Meta Executive**: befehligen die Suche, lernen ihre Politik aus Ergebnissen
- **Expert Evolution**: Experten teilen/vereinigen/gehen in den Ruhestand nach objektiven Kriterien (Gesundheit, Überlappung, Auslastung)
- **Thinking Modes**: Fast / Auto / Deep / Custom — gleiches OS, andere Pipeline
- **Erklärbar**: **Decision Explanation** (warum diese Konfiguration), **Decision Replay** (Schritt-für-Schritt), **OS Policy Learning** (Entscheidungen werden Trainingsdaten)
- **Validierung**: Simulation und Real Device getrennt; externe Benchmarks: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench (die Qwen1.5B-Zeilen sind **Messungen vor der Trennung**; Validierung per realer API → siehe Phase 4 unten)

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

## 🤖 SWE-bench — Validierung an realen Problemen (Coding-Agent)

Der Software-Engineering-Agent von ArcAsha (`akasha-master/src/arcasha/swe/`) hat reale SWE-bench-Lite-Instanzen über die echte API gelöst (`deepseek-v4-flash`, `temperature=0`). Details: `akasha-master/README.md`.

- **3 ausgewählte sympy-Instanzen** aus SWE-bench Lite (Test-Split): `24213` (Dimensions-Äquivalenz), `23117` (`Array([])`), `24152` (`TensorProduct.expand`)
- **Ergebnis: 3/3 gelöst (100 %)** — 26/29/11 Modellaufrufe, 31/44/13 Tools, 93s/206s/71s pro Instanz; der Agent ändert nur den **Quellcode** und verifiziert mit pytest; Testdateien sind schreibgeschützt (goldener `test_patch` wird bei der Auswertung angewendet)
- Ehrliche Hinweise: LLM-Ausgabe ist stochastisch (1 Instanz brauchte einen Retry); 3 ausgewählte Aufgaben sind keine statistische Schätzung; **Token-Verbrauch wurde in diesem Lauf nicht erfasst** (Usage-Aggregation ist im Harness ergänzt — künftige Läufe schreiben sie in `akasha-master/reports/swebench/swebench-results.json`)

### Normales DeepSeek vs. arcasha (kontrollierter 1-Instanz-Vergleich, 2026-09)

Um den Wert der Agent-/Werkzeug-Ebene zu quantifizieren, verglichen wir auf **derselben
Instanz** `sympy__sympy-24213` „nacktes `deepseek-v4-flash` (Problem + Dateiauszug,
unified diff in einem Zug)” mit „arcasha-Agent”. Echte API-Messungen. Details:
`akasha-master/reports/swebench/compare-deepseek-vs-arcasha.md`.

- **Normales DeepSeek: 0/3 gelöst** — fand jedes Mal die mit gold identische richtige
  Korrektur, aber das handgeschriebene unified diff hatte falsche hunk-Zeilenanzahl /
  abgeschnittenen Kontext, `git apply` lehnte jedes Mal ab (43.184 Tokens / $0,027 off-peak / 267 s)
- **arcasha: 1/1 gelöst** — bearbeitet Dateien direkt per `edit_file`, das diff erzeugt git
  (keine Hand-Rechnung) → immer anwendbar (741.409 Tokens / $0,170 off-peak / 127 s)
- Fazit: Für SWE-bench braucht es nicht nur „die Korrektur zu kennen“, sondern ein **Werkzeug
  zum Anwenden auf echte Dateien**; One-Shot-diff ist möglich, aber unzuverlässig

## 🧪 Status

- **v1.0 veröffentlicht** — erste KI-OS-Generation (ISA/IR/Kernel/AVM → echte Geräte → Reasoning → Executive/Meta → Attachments → Validation)
- **v1.1** — Decision Replay, Real-Device-Benchmark-Plan (Mac / iPhone 15 Pro / iPad M4)
- **Phase 4: Validierung per realer API (2026-09)** — Komponenten-Ablation (Baseline/AVM/Executive/Full, 50 Aufgaben × 3) + Langtext-AVM (96,5 % Token-Reduktion bei 100 %) + Executive-Engpass (Doppelaufruf-Bug behoben: +348ms → +37ms, in PR #37 gemessen)
- selftest [1]-[72] alle bestanden / golden 30 / AILSA selftest / build + dist verifiziert

## 🔬 Forschungspositionierung

ArcAsha ist nicht „ein größeres Modell":

> **Eine reproduzierbare experimentelle Plattform, um KI-Intelligenz auf OS-Ebene zu komponieren, zu steuern und zu messen.**

Der neuartigste Punkt: Das OS kann **erklären, warum** Reflection / Planning / Debate verwendet wurden (Decision Explanation), den gesamten Entscheidungsprozess **abspielen** (Decision Replay) und aus eigenen Entscheidungen **lernen** (OS Policy Learning) — eine zu Transformer-Pretraining orthogonale Lernachse.

## Lizenz
MIT — siehe `LICENSE`.
