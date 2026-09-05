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

## 💬 Asistente de IA (Chat WebUI enriquecido・con memoria a largo plazo)

Un **asistente de IA** que cualquier usuario puede usar de inmediato para tareas cotidianas
(estilo Hermes Agent / DeepSeek Web UI・cero dependencias). Varios modelos
(`deepseek-v4-flash` / `deepseek-v4-pro`) se enrutan automáticamente por clasificación de
tarea; la **memoria a largo plazo** (datos del usuario・gustos・hilos de chat) se persiste
en JSON (sobrevive a reinicios).

```bash
cd akasha-master
npm run assistant          # Inicia en http://localhost:4781
npm run assistant:test     # Pruebas unitarias de memoria + reglas de extracción (21 tests)
```

- **Modo casual (predeterminado)**: tareas diarias en lenguaje natural (consulta・texto・resumen・ideas).
  Las presentaciones («Me llamo …» / «me gusta/no me gusta …») se recuerdan automáticamente
- **Modo experto**: cambia arriba a la derecha → comandos `/help` `/memory` `/remember` `/forget` `/pin`
- **API compatible OpenAI**: `POST /v1/chat/completions` (baseURL = `http://localhost:4781/v1`)
  utilizable desde Cursor y otras herramientas. `/v1/models` lista los modelos
- **Ubicación de la memoria**: `~/.arcasha/assistant-memory.json` (cambiable con `ARCASHA_MEMORY_DIR`)
- Implementación: `src/arcasha/assistant/` (server / long-term-memory / remember / ui.html)

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

Tras la Fase 4, el agente de ingeniería de software de ArcAsha (`src/arcasha/swe/`, bucle de herramientas) resolvió instancias reales de SWE-bench Lite con API real. Todas las cifras son medidas.

- **Objetos**: 3 instancias de **sympy/sympy** seleccionadas de `princeton-nlp/SWE-bench_Lite` (test split, 300 tareas; Python puro, sin dependencias, evaluables localmente) — `24213` (equivalencia de dimensiones) / `23117` (`Array([])`) / `24152` (`TensorProduct.expand`)
- **Modelo**: `deepseek-v4-flash` (API real, `temperature=0`) / Entorno: macOS / Python 3.13.2 / pytest 9.1.1 / sympy instalado editable en base_commit
- **Evaluación**: checkout `base_commit` → el agente edita solo el **código fuente** → restablecer worktree → aplicar `test_patch` de oro → aplicar parche del agente → ejecutar `FAIL_TO_PASS`/`PASS_TO_PASS` con pytest → resolved si todos los F2P pasan. Los tests solo con nombre de función se resuelven automáticamente a `archivo::función`
- **Resultado: 3/3 resueltas (100 %)** — llamadas de modelo 26/29/11, herramientas 31/44/13, 93s/206s/71s por instancia
- Notas honestas: la salida del LLM es estocástica (`23117` falló una vez con “respuesta incompleta”; el reintento lo resolvió; `22005` no fue evaluable por incompatibilidad de su base_commit de 2021 con Python 3.13 – `distutils` eliminado); 3 tareas seleccionadas no son una estimación estadística; **el consumo de tokens no se registró en esta ejecución** (`agent.ts`/`eval.ts` ya tienen agregación de usage; las próximas ejecuciones lo guardan en `reports/swebench/swebench-results.json`)
- Harness de evaluación (código): `src/arcasha/swe/`; resultados commiteados: `reports/swebench/swebench-results.json`

### DeepSeek normal vs arcasha (comparación controlada de 1 instancia, 2026-09)

Para cuantificar qué aporta la capa de agente/herramientas frente a una **llamada de modelo
desnuda**, comparamos en la **misma instancia** (`sympy__sympy-24213`):

- **DeepSeek normal** — `deepseek-v4-flash` desnudo (thinking ON, `reasoning_effort=high`)
  con el texto del issue **+ el extracto del archivo objetivo**, pidiéndole escribir un
  unified diff a mano de una sola vez. 3 intentos.
- **arcasha** — el agente SWE descrito arriba (bucle de herramientas).

Todas las cifras son mediciones reales de la API; el coste usa la tarifa oficial de
`deepseek-v4-flash` (off-peak: entrada $0,22 / salida $0,66 por 1M). Detalles y datos
brutos: `reports/swebench/compare-deepseek-vs-arcasha.{md,json}`.

| Métrica | DeepSeek normal (3 intentos) | arcasha |
|---|---:|---:|
| resuelto | ❌ 0/3 | ✅ 1/1 |
| tokens de entrada | 3.756 | 726.877 |
| tokens de salida | 39.428 | 14.532 |
| tokens totales | 43.184 | 741.409 |
| tiempo | 267 s (3 intentos) | 127 s |
| coste (off-peak, $) | $0,027 | $0,170 |

**Hallazgo clave**: el modelo desnudo identificó en cada intento la corrección correcta
(idéntica al parche de oro, comprobación `equivalent_dims`). Pero debe **escribir a mano**
el unified diff; en los 3 intentos el recuento de líneas de hunk era erróneo o el contexto
estaba truncado, así que `git apply` rechazó el parche (0/3). El agente edita los archivos
**directamente** con `edit_file`/`write_file`, de modo que el diff lo genera git (sin
cálculo manual de hunks) → siempre aplicable → resuelto. Conclusión: resolver SWE-bench no
requiere solo “saber la corrección”, sino una **herramienta para aplicarla a archivos reales**.

- Nota honesta: estocástico (otra ejecución única también resolvió 1/1; el diff de un solo
  disparo es posible pero poco fiable)・solo 1 instancia, no es una estimación estadística.

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
