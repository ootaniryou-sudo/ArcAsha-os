# ArcAsha (Akasha-OS)

> **Un sistema operativo para IA — razonamiento modular e inteligencia en tiempo de ejecución**

ArcAsha **no es un modelo**. Es un **sistema operativo que se ejecuta sobre los modelos neuronales** — configura, controla, mide y **explica** el razonamiento de IA a nivel de SO.

- **No modificamos** el modelo.
- Colocamos una **capa de SO fuera del modelo** para gestionar enrutamiento, memoria, razonamiento, planificación y automejora.

> **Pregunta central de investigación**: ¿podemos componer, controlar y medir la inteligencia a nivel de SO — y demostrarlo de forma reproducible — en lugar de agrandar el modelo?

---

## 🎯 Por qué ArcAsha

GPT / MoE realizan todo el razonamiento **dentro** de la red neuronal (caja negra).

ArcAsha saca el razonamiento del modelo:

```
Task → Compiler → AILSM IR → Kernel → Executive → Hypothesis → Search → Experts → Memory
```

- **AILSM / AILSA** : IR e ISA específicos de IA (el «lenguaje de máquina» del razonamiento)
- **AVM** : Memoria virtual de IA (solo se carga el contexto necesario, como paginación bajo demanda)
- **Executive / Meta Executive** : dirigen todo el razonamiento y aprenden su propia política
- **Intelligence Attachments** : inteligencia avanzada cargada solo cuando se necesita (como módulos de kernel opcionales)

---

## 🏗️ Arquitectura (3 capas)

```
Layer 3  Intelligence Attachments (Reflection / Debate / Planning / Search / Creativity / Simulation / Coding)
Layer 2  Executive Runtime (Executive / Meta Executive / Expert Evolution / Intelligence Scheduler)
Layer 1  Fast Runtime (Kernel / AVM / Expert Runtime / ODAR / Device Tree) — siempre rápido
```

**Separación Fast / Deliberation**: Fast mantiene el control en tiempo real (robot 30.3 fps), Deliberation solo se carga cuando se necesita (investigación / razonamiento largo).

## ✨ Características clave

- **AVM** : contexto como memoria virtual paginada bajo demanda (validado con API real – contexto largo: **reducción de tokens del 96,5 % con precisión 100 %** — la cifra antigua 4.10x / −77 % es una medición **anterior a la separación**)
- **Executive / Meta Executive** : dirigen la búsqueda y aprenden su política de los resultados
- **Expert Evolution** : los expertos se dividen / fusionan / retiran según criterios objetivos (salud, solapamiento, utilización)
- **Thinking Modes** : Fast / Auto / Deep / Custom — mismo SO, diferente pipeline
- **Explicable** : **Decision Explanation** (por qué esta configuración), **Decision Replay** (reproducción paso a paso), **OS Policy Learning** (las decisiones se vuelven datos de entrenamiento)
- **Validación** : Simulation y Real Device separados ; benchmarks externos : GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench (las filas Qwen1.5B son mediciones **anteriores a la separación**; validación con API real → ver Phase 4 abajo)

---

## 🚀 Inicio rápido

```bash
npm install arcasha
arcasha benchmark   # Benchmark completo (Simulation) + Decision Explanation + reports/
arcasha replay      # «¿Por qué esta respuesta?» — reproducción paso a paso
arcasha policy      # Demo de aprendizaje de política del SO
```

Desde el repositorio:

```bash
cd akasha-master
npm install
npm run ailsm:selftest          # 72 pruebas deterministas
npm run benchmark               # Benchmark completo + reports/ (json/csv/md)
npx tsx examples/quickstart.ts  # Recorrido de 5 minutos
```

---

## 📁 Estructura del repositorio

```
akasha-master/        Implementación principal (TypeScript / AILSA / AILSM / Kernel / AVM / Executive / Attachments)
akasha-link/          Project A: Akasha-Link (inferencia distribuida / transporte de tensores)
  ├── client-web/     Cliente web (inferencia WebGPU)
  └── kernel-native/  Prototipo de kernel nativo (Rust)
examples/             Ejemplos de plugins (code / math)
AI_*.md               Especificaciones
```

## 📚 Documentación

`MASTER_SPEC.md` (visión) / `ARCASHA_V2_SPEC.md` (espec v2 v0.36) / `AI_REASONING.md` (runtime de razonamiento) / `AI_ATTACHMENTS.md` (capa de plugins) / `AI_VALIDATION.md` (validación y explicación) / `AI_VIRTUAL_MEMORY.md` (AVM) / `PAPER_OUTLINE.md` (artículo) / `CHANGELOG.md` (historial)

## 🤖 Validación con problemas reales de SWE-bench (agente de código)

El agente de ingeniería de software de ArcAsha (`akasha-master/src/arcasha/swe/`) resolvió instancias reales de SWE-bench Lite con API real (`deepseek-v4-flash`, `temperature=0`). Detalles: `akasha-master/README.md`.

- **3 instancias de sympy seleccionadas** de SWE-bench Lite (test split): `24213` (equivalencia de dimensiones), `23117` (`Array([])`), `24152` (`TensorProduct.expand`)
- **Resultado: 3/3 resueltas (100 %)** — 26/29/11 llamadas de modelo, 31/44/13 herramientas, 93s/206s/71s por instancia; el agente edita solo el **código fuente** y verifica con pytest; los archivos de test están protegidos contra escritura (el `test_patch` de oro se aplica en la evaluación)
- Notas honestas: la salida del LLM es estocástica (1 instancia requirió reintento); 3 tareas seleccionadas no son una estimación estadística; **el consumo de tokens no se registró en esta ejecución** (la agregación de usage ya está añadida al harness — las próximas ejecuciones lo guardan en `akasha-master/reports/swebench/swebench-results.json`)

## 🧪 Estado

- **v1.0 publicada** — primera generación de AI OS (ISA/IR/Kernel/AVM → dispositivos reales → Reasoning → Executive/Meta → Attachments → Validation)
- **v1.1** — Decision Replay, plan de benchmark en dispositivos reales (Mac / iPhone 15 Pro / iPad M4)
- **Phase 4: validación con API real (2026-09)** — ablación de componentes (Baseline/AVM/Executive/Full, 50 tareas × 3) + AVM de texto largo (96,5 % reducción de tokens con 100 %) + cuello de botella Executive (bug de doble llamada corregido: +348ms → +37ms, medido en PR #37)
- selftest [1]-[72] todos pasan / golden 30 / AILSA selftest / build + dist verificados

## 🔬 Posicionamiento de investigación

ArcAsha no es «un modelo más grande»:

> **Una plataforma experimental reproducible para componer, controlar y medir la inteligencia de IA a nivel de SO.**

El punto más novedoso: el SO puede **explicar por qué** se usaron Reflection / Planning / Debate (Decision Explanation), **reproducir** todo el proceso de decisión (Decision Replay), y **aprender de sus propias decisiones** (OS Policy Learning) — un eje de aprendizaje ortogonal al preentrenamiento de Transformers.

## Licencia
MIT — ver `LICENSE`.
