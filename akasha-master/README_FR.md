# ArcAsha (Akasha-OS)

> **Un système d'exploitation pour l'IA — raisonnement modulaire et intelligence d'exécution**

ArcAsha n'est **pas un modèle**. C'est un **système d'exploitation qui s'exécute au-dessus des modèles neuronaux** — il configure, contrôle, mesure et **explique** le raisonnement IA au niveau OS.

- Nous ne **modifions pas** le modèle.
- Nous plaçons une **couche OS à l'extérieur** du modèle pour gérer le routage, la mémoire, le raisonnement, l'ordonnancement et l'auto-amélioration.

> **Question de recherche centrale** : pouvons-nous composer, contrôler et mesurer l'intelligence au niveau OS — et le prouver de manière reproductible — plutôt que d'agrandir le modèle ?

---

## 🎯 Pourquoi ArcAsha

GPT / MoE effectuent tout le raisonnement **à l'intérieur** du réseau neuronal (boîte noire).

ArcAsha fait sortir le raisonnement du modèle :

```
Task → Compiler → AILSM IR → Kernel → Executive → Hypothesis → Search → Experts → Memory
```

- **AILSM / AILSA** : IR et ISA spécifiques à l'IA (le « langage machine » du raisonnement)
- **AVM** : Mémoire virtuelle IA (seul le contexte nécessaire est chargé, par pagination à la demande)
- **Executive / Meta Executive** : commandent tout le raisonnement et apprennent leur propre politique
- **Intelligence Attachments** : intelligence avancée chargée uniquement si nécessaire (comme des modules noyau optionnels)

---

## 🏗️ Architecture (3 couches)

```
Layer 3  Intelligence Attachments (Reflection / Debate / Planning / Search / Creativity / Simulation / Coding)
Layer 2  Executive Runtime (Executive / Meta Executive / Expert Evolution / Intelligence Scheduler)
Layer 1  Fast Runtime (Kernel / AVM / Expert Runtime / ODAR / Device Tree) — toujours rapide
```

**Séparation Fast / Deliberation** : Fast maintient le contrôle temps réel (robot 30.3 fps), Deliberation ne se charge que si nécessaire (recherche / raisonnement long).

## ✨ Fonctionnalités clés

- **AVM** : contexte comme mémoire virtuelle paginée à la demande (validé par API réelle – contexte long : **réduction de tokens de 96,5 % avec précision 100 %** — l'ancienne valeur 4.10x / −77 % est une mesure **antérieure à la séparation**)
- **Executive / Meta Executive** : commandent la recherche, apprennent leur politique des résultats
- **Expert Evolution** : les experts se divisent / fusionnent / prennent leur retraite selon des critères objectifs (santé, chevauchement, utilisation)
- **Thinking Modes** : Fast / Auto / Deep / Custom — même OS, pipeline différent
- **Explicable** : **Decision Explanation** (pourquoi cette configuration), **Decision Replay** (relecture pas à pas), **OS Policy Learning** (les décisions deviennent des données d'apprentissage)
- **Validation** : Simulation et Real Device séparés ; benchmarks externes : GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench (les lignes Qwen1.5B sont des mesures **antérieures à la séparation** ; validation par API réelle → voir Phase 4 ci-dessous)

---

## 🚀 Démarrage rapide

```bash
npm install arcasha
arcasha benchmark   # Benchmark complet (Simulation) + Decision Explanation + reports/
arcasha replay      # « Pourquoi cette réponse ? » — relecture pas à pas
arcasha policy      # Démo d'apprentissage de politique OS
```

Depuis le dépôt :

```bash
cd akasha-master
npm install
npm run ailsm:selftest          # 72 tests déterministes
npm run benchmark               # Benchmark complet + reports/ (json/csv/md)
npx tsx examples/quickstart.ts  # Visite de 5 minutes
```

---

## 📁 Structure du dépôt

```
akasha-master/        Implémentation principale (TypeScript / AILSA / AILSM / Kernel / AVM / Executive / Attachments)
akasha-link/          Project A: Akasha-Link (inférence distribuée / transport de tenseurs)
  ├── client-web/     Client web (inférence WebGPU)
  └── kernel-native/  Prototype de noyau natif (Rust)
examples/             Exemples de plugins (code / math)
AI_*.md               Spécifications
```

## 📚 Documentation

`MASTER_SPEC.md` (vision) / `ARCASHA_V2_SPEC.md` (spec v2 v0.36) / `AI_REASONING.md` (runtime de raisonnement) / `AI_ATTACHMENTS.md` (couche plugins) / `AI_VALIDATION.md` (validation & explication) / `AI_VIRTUAL_MEMORY.md` (AVM) / `PAPER_OUTLINE.md` (papier) / `CHANGELOG.md` (historique)

## 🤖 Validation sur problèmes réels SWE-bench (agent de code)

Après la Phase 4, l'agent d'ingénierie logicielle d'ArcAsha (`src/arcasha/swe/`, boucle d'outils) a résolu des instances réelles de SWE-bench Lite via l'API réelle. Tous les chiffres sont mesurés.

- **Objets** : 3 instances **sympy/sympy** sélectionnées dans `princeton-nlp/SWE-bench_Lite` (test split, 300 tâches ; Python pur, zéro dépendance, évaluables localement) — `24213` (équivalence de dimensions) / `23117` (`Array([])`) / `24152` (`TensorProduct.expand`)
- **Modèle** : `deepseek-v4-flash` (API réelle, `temperature=0`) / Environnement : macOS / Python 3.13.2 / pytest 9.1.1 / sympy installé en editable sur base_commit
- **Évaluation** : checkout `base_commit` → l'agent ne modifie que le **code source** → réinitialiser le worktree → appliquer le `test_patch` de référence → appliquer le correctif de l'agent → exécuter `FAIL_TO_PASS`/`PASS_TO_PASS` via pytest → resolved si tous les F2P passent. Les tests en nom-de-fonction seul sont résolus automatiquement en `fichier::fonction`
- **Résultat : 3/3 résolues (100 %)** — appels modèle 26/29/11, outils 31/44/13, 93s/206s/71s par instance
- Remarques honnêtes : la sortie LLM est stochastique (`23117` a échoué une fois avec « réponse incomplète » ; le nouvel essai l'a résolu ; `22005` non évaluable — son base_commit de 2021 est incompatible avec Python 3.13, `distutils` supprimé) ; 3 tâches sélectionnées ne constituent pas une estimation statistique ; **la consommation de tokens n'a pas été enregistrée lors de cet essai** (`agent.ts`/`eval.ts` ont désormais l'agrégation usage ; les prochains essais l'enregistrent dans `reports/swebench/swebench-results.json`)
- Harnais d'évaluation (code) : `src/arcasha/swe/` ; résultats commités : `reports/swebench/swebench-results.json`

## 🧪 Statut

- **v1.0 publiée** — première génération d'AI OS (ISA/IR/Kernel/AVM → appareils réels → Reasoning → Executive/Meta → Attachments → Validation)
- **v1.1** — Decision Replay, plan de benchmark sur appareils réels (Mac / iPhone 15 Pro / iPad M4)
- **Phase 4 : validation par API réelle (2026-09)** — ablation de composants (Baseline/AVM/Executive/Full, 50 tâches × 3) + AVM long contexte (96,5 % de réduction de tokens à 100 %) + goulot Executive (bug de double appel corrigé : +348ms → +37ms, mesuré dans PR #37)
- selftest [1]-[72] tous réussis / golden 30 / AILSA selftest / build + dist vérifiés

## 🔬 Positionnement de recherche

ArcAsha n'est pas « un plus gros modèle » :

> **Une plateforme expérimentale reproductible pour composer, contrôler et mesurer l'intelligence IA au niveau OS.**

Le point le plus nouveau : l'OS peut **expliquer pourquoi** Reflection / Planning / Debate ont été utilisés (Decision Explanation), **rejouer** tout le processus de décision (Decision Replay), et **apprendre de ses propres décisions** (OS Policy Learning) — un axe d'apprentissage orthogonal au pré-entraînement des Transformers.

## Licence
MIT — voir `LICENSE`.
