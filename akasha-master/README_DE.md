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

## 💬 KI-Assistent (reichhaltige Chat-WebUI・mit Langzeitgedächtnis)

Ein **KI-Assistent**, den auch Nicht-Fachleute sofort für Alltagsaufgaben nutzen können
(Hermes-Agent / DeepSeek-WebUI-Stil・ohne Abhängigkeiten). Mehrere Modelle
(`deepseek-v4-flash` / `deepseek-v4-pro`) werden per Aufgabenklassifikation geroutet;
**Langzeitgedächtnis** (Nutzerinfos・Vorlieben・Chat-Verläufe) wird als JSON persistiert
(übersteht Neustarts).

```bash
cd akasha-master
npm run assistant          # Start unter http://localhost:4781
npm run assistant:test     # Unit-Tests für Gedächtnis + Extraktionsregeln (21 Tests)
```

- **Casual-Modus (Standard)**: Alltagsaufgaben in natürlicher Sprache (Beratung・Text・Zusammenfassung・Ideen).
  Selbstvorstellungen („Mein Name ist …“ / „ich mag/mag nicht …“) werden automatisch gemerkt
- **Expertenmodus**: Umschalten oben rechts → Slash-Befehle wie `/help` `/memory` `/remember` `/forget` `/pin`
- **AI Coding Agent (Workspace Write)**: Access mode unten links auf `Workspace Write` stellen und per Chat **echte Dateien bearbeiten** (SWE-Agent-Tool-Loop mit Streaming von Tool-Calls, „Thought for a while“ und Trajectory-Log)
- **Mehrsprachige Endpunkte**: `/ja` `/en` `/zh` `/ko` wechseln die UI-Sprache (der 🌐-Chip oben tut dasselbe; `/` nutzt die gespeicherte Sprache)
- **Einstellungen-Tab**: API-Key / Base-URL per Web setzen (überschreibt .env; gespeichert unter `~/.arcasha/assistant-settings.json`, Key maskiert), Modellauswahl mit eigener Modelleingabe („Sonstiges“)
- **Orchestrierungssteuerung**: Anzahl teilnehmender Modelle (1–4) per Slider — 1 = nur Flash / 2 = Flash + Pro (Standard) / 3–4 = erweiterte Fallback-Kette
- **Hyper-Thinking-Modus**: `thinking` + `reasoning_effort=max` + 8000-Token-Budget für tiefes Reasoning
- **AILSM-Ausgabe-Viewer**: Jede Antwort hat einen „⚙ AILSM-Ausgabe“-Button (AILSA-Befehle, Verifikation, Bytes hex) — auch in **bereits beendeten Chats** abrufbar
- **AILSM-Befehlswörterbuch-Tab**: `registry.json` (einzige Autorität) kategorisiert + durchsuchbar
- **OpenAI-kompatible API**: `POST /v1/chat/completions` (baseURL = `http://localhost:4781/v1`)
  – direkt aus Cursor u. a. nutzbar. `/v1/models` listet Modelle
- **Speicherort**: `~/.arcasha/assistant-memory.json` (`ARCASHA_MEMORY_DIR` änderbar)
- Implementierung: `src/arcasha/assistant/` (server / settings / long-term-memory / remember / ui.html)

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

Im Anschluss an Phase 4 hat der Software-Engineering-Agent von ArcAsha (`src/arcasha/swe/`, Tool-Loop) reale SWE-bench-Lite-Instanzen über die echte API gelöst. Alle Zahlen sind gemessen.

- **Objekte**: 3 ausgewählte **sympy/sympy**-Instanzen aus `princeton-nlp/SWE-bench_Lite` (Test-Split, 300 Aufgaben; reines Python, keine Abhängigkeiten, lokal auswertbar) — `24213` (Dimensions-Äquivalenz) / `23117` (`Array([])`) / `24152` (`TensorProduct.expand`)
- **Modell**: `deepseek-v4-flash` (echte API, `temperature=0`) / Umgebung: macOS / Python 3.13.2 / pytest 9.1.1 / sympy per editable install auf base_commit
- **Auswertung**: checkout `base_commit` → Agent ändert nur **Quellcode** → Worktree zurücksetzen → goldenes `test_patch` anwenden → Agent-Patch anwenden → `FAIL_TO_PASS`/`PASS_TO_PASS` per pytest → resolved, wenn alle F2P bestehen. Nur-Funktionsname-Tests werden automatisch zu `Datei::Funktion` aufgelöst
- **Ergebnis: 3/3 gelöst (100 %)** — Modellaufrufe 26/29/11, Tools 31/44/13, 93s/206s/71s pro Instanz
- Ehrliche Hinweise: LLM-Ausgabe ist stochastisch (`23117` scheiterte einmal mit „unvollständiger Antwort“, Retry löste es; `22005` wegen Inkompatibilität des 2021er base_commit mit Python 3.13 – `distutils` entfernt – nicht auswertbar); 3 ausgewählte Aufgaben sind keine statistische Schätzung; **Token-Verbrauch in diesem Lauf nicht erfasst** (`agent.ts`/`eval.ts` haben nun Usage-Aggregation; künftige Läufe schreiben `reports/swebench/swebench-results.json`)
- Evaluierungs-Harness (Code): `src/arcasha/swe/`; committete Ergebnisse: `reports/swebench/swebench-results.json`

### Normales DeepSeek vs. arcasha (kontrollierter 1-Instanz-Vergleich, 2026-09)

Um zu quantifizieren, was die Agent-/Tool-Ebene gegenüber einem **nackten Modellaufruf**
hinzufügt, verglichen wir auf **derselben Instanz** (`sympy__sympy-24213`):

- **Normales DeepSeek** — nackter `deepseek-v4-flash` (Thinking ON, `reasoning_effort=high`),
  erhielt Problemtext **+ Auszug der Zieldatei** und sollte in einem Zug ein unified diff
  von Hand schreiben. 3 Versuche.
- **arcasha** — der oben beschriebene SWE-Agent (Tool-Loop).

Alle Zahlen sind echte API-Messungen; Kosten nach offizieller `deepseek-v4-flash`-Preisliste
(off-peak: Eingabe $0,22 / Ausgabe $0,66 pro 1M). Details & Rohdaten:
`reports/swebench/compare-deepseek-vs-arcasha.{md,json}`.

| Kennzahl | Normales DeepSeek (3 Versuche) | arcasha |
|---|---:|---:|
| gelöst | ❌ 0/3 | ✅ 1/1 |
| Eingabe-Tokens | 3.756 | 726.877 |
| Ausgabe-Tokens | 39.428 | 14.532 |
| Gesamt-Tokens | 43.184 | 741.409 |
| Zeit | 267 s (3 Versuche) | 127 s |
| Kosten (off-peak, $) | $0,027 | $0,170 |

**Kernerkenntnis**: Das nackte Modell fand bei jedem Versuch die richtige Korrektur
(identisch zum Gold-Patch, `equivalent_dims`-Prüfung). Aber es muss das unified diff
**von Hand schreiben**; in allen 3 Versuchen waren die hunk-Zeilenanzahl falsch bzw. der
Kontext abgeschnitten, sodass `git apply` den Patch ablehnte (0/3). Der Agent bearbeitet
Dateien **direkt** über `edit_file`/`write_file`, das diff erzeugt git selbst (keine
Hand-Hunk-Rechnung) → immer anwendbar → gelöst. Fazit: Für SWE-bench braucht es nicht nur
„die Korrektur zu kennen“, sondern ein **Werkzeug, um sie auf echte Dateien anzuwenden**.

- Ehrlicher Hinweis: stochastisch (ein separater Einzel-Lauf löste ebenfalls 1/1; Ein-Schuss-
  diff ist möglich, aber unzuverlässig)・nur 1 Instanz, keine statistische Schätzung.

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
