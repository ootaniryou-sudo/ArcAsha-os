# Akasha-Kernel — Build & Cross-Compilation Guide

## 前提 / Prerequisites

```bash
# Rust toolchain
rustup default stable
rustup target add aarch64-linux-android    # Android 64-bit
rustup target add armv7-linux-androideabi  # Android 32-bit (legacy)
rustup target add aarch64-apple-ios        # iOS 64-bit
rustup target add x86_64-apple-ios         # iOS Simulator

# Android NDK
# Download from: https://developer.android.com/ndk/downloads
export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/27.0.12077973
export PATH=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin:$PATH
```

---

## 1. デスクトップ（開発・テスト）/ Desktop (dev/test)

```bash
cd kernel

# チェックのみ
cargo check

# ビルド
cargo build --release

# 実行（マスターへ接続）
cargo run --release -- \
  --master 192.168.1.100:8080 \
  --node-id 0xCAFE0001 \
  --hidden-size 2048 \
  --num-layers 12

# QUIC無効 / TCPで接続
cargo run --release -- --master 127.0.0.1:8080 --tcp
```

---

## 2. Android 向けクロスコンパイル / Cross-compile for Android

### 2.1 静的ライブラリ (.so) ビルド

```bash
# aarch64 (ARM64 — 最新の全スマホ)
cargo build --release --target aarch64-linux-android

# armv7 (32bit — 超低スペック用)
cargo build --release --target armv7-linux-androideabi

# 出力先
ls -lh target/aarch64-linux-android/release/libakasha_kernel.so
ls -lh target/armv7-linux-androideabi/release/libakasha_kernel.so
```

### 2.2 Cargo 設定 (~/.cargo/config.toml)

```toml
[target.aarch64-linux-android]
linker = "aarch64-linux-android26-clang"

[target.armv7-linux-androideabi]
linker = "armv7a-linux-androideabi26-clang"
```

### 2.3 Kotlin/JNI 統合

```kotlin
// AkashaKernel.kt
class AkashaKernel {
    companion object {
        init {
            System.loadLibrary("akasha_kernel")
        }
    }

    external fun nativeInit(configJson: String): Long
    external fun nativeStart(kernelPtr: Long): Int
    external fun nativeShutdown(kernelPtr: Long)
}
```

**JNI 関数名の対応表 / JNI name mapping:**

| Rust `#[no_mangle]` symbol | Kotlin `external fun` |
|---|---|
| `Java_com_akasha_kernel_AkashaKernel_nativeInit` | `nativeInit(configJson: String): Long` |
| `Java_com_akasha_kernel_AkashaKernel_nativeStart` | `nativeStart(kernelPtr: Long): Int` |
| `Java_com_akasha_kernel_AkashaKernel_nativeShutdown` | `nativeShutdown(kernelPtr: Long)` |

**C FFI 経由の場合 (C/C++ ブリッジ):**

```c
// akasha_bridge.h
void* akasha_kernel_init(const char* config_json);
int   akasha_kernel_run(void* kernel);
void  akasha_kernel_shutdown(void* kernel);
```

### 2.4 Android フォアグラウンドサービス統合

```xml
<!-- AndroidManifest.xml -->
<service
    android:name=".AkashaForegroundService"
    android:foregroundServiceType="dataSync"
    android:exported="false" />

<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

---

## 3. iOS 向けクロスコンパイル / Cross-compile for iOS

### 3.1 静的ライブラリ (.a) ビルド

```bash
# 実機 (ARM64)
cargo build --release --target aarch64-apple-ios

# シミュレーター (Apple Silicon Mac)
cargo build --release --target aarch64-apple-ios-sim

# 出力先
ls -lh target/aarch64-apple-ios/release/libakasha_kernel.a
```

### 3.2 Xcode 統合

1. `libakasha_kernel.a` を Xcode プロジェクトにドラッグ
2. `akasha_bridge.h` を Bridging Header に追加
3. Swift から C FFI を呼び出す:

```swift
// AkashaBridge.swift
import Foundation
import BackgroundTasks

class AkashaBridge {
    func startInference(configJson: String) {
        let config = strdup(configJson)
        defer { free(config) }

        let kernel = akasha_kernel_init(config)
        DispatchQueue.global(qos: .userInitiated).async {
            _ = akasha_kernel_run(kernel)
        }
    }
}
```

### 3.3 iOS バックグラウンドタスク登録

```swift
// AppDelegate.swift または BGTaskScheduler 登録箇所
import BackgroundTasks

BGTaskScheduler.shared.register(
    forTaskWithIdentifier: "com.akasha.inference",
    using: nil
) { task in
    let config = """
    {"hidden_size":2048,"num_layers":12,"master_addr":"192.168.1.100:8080"}
    """
    AkashaBridge().startInference(configJson: config)
    task.setTaskCompleted(success: true)
}
```

---

## 4. wgpu バックエンド選択 / GPU Backend Selection

`wgpu` はコンパイル時にターゲットプラットフォームのネイティブGPU APIを自動選択します。

| プラットフォーム | 自動選択されるバックエンド | Cargo feature (上書き) |
|---|---|---|
| Android | Vulkan | `--features vulkan` |
| iOS | Metal | `--features metal` |
| Linux | Vulkan (優先) / GLES | `--features vulkan` |
| macOS | Metal | `--features metal` |
| Windows | DirectX 12 | `--features dx12` |

**強制指定が必要なケース / When to force a backend:**

```bash
# Android端末でVulkan非対応 → OpenGL ESに強制フォールバック
cargo build --release --target aarch64-linux-android --no-default-features --features "tcp-only"

# iOSシミュレーターでMetal強制
cargo build --release --target aarch64-apple-ios-sim --features metal
```

---

## 5. 最適化プロファイル / Optimisation Profiles

`Cargo.toml` の `[profile.release]` 設定:

| 設定 | 値 | 効果 |
|---|---|---|
| `opt-level` | 3 | 最大限の最適化 |
| `lto` | "fat" | リンク時最適化（バイナリサイズ -15%、速度 +5%） |
| `codegen-units` | 1 | 単一コード生成ユニット（より積極的なインライン化） |
| `panic` | "abort" | パニック時にスタック巻き戻し無し（バイナリサイズ削減） |
| `strip` | "symbols" | デバッグシンボル除去 |

---

## 6. ファイル構造まとめ / File Structure

```
kernel/
├── Cargo.toml                  # 依存関係とフィーチャーフラグ
├── BUILD.md                    # ← このファイル
└── src/
    ├── main.rs                 # デスクトップ用バイナリエントリポイント
    ├── lib.rs                  # ライブラリエントリ（JNI/C FFI エクスポート）
    ├── kernel.rs               # カーネル統合（プール+GPU+ネットワーク+プラットフォーム）
    ├── protocol.rs             # 48バイトヘッダバイナリコーデック
    ├── memory/
    │   ├── mod.rs
    │   └── pool.rs             # 固定長テンソルメモリプール（UnsafeCell + AtomicU64）
    ├── gpu/
    │   ├── mod.rs
    │   ├── compute.rs          # wgpu 計算エンジン（パイプライン管理+ディスパッチ）
    │   └── shaders.rs          # WGSL シェーダー（matmul, GELU, RMSNorm, ResidualAdd）
    ├── net/
    │   ├── mod.rs              # Transport トレイト + QUIC/TCP 選択
    │   ├── quic_stream.rs      # QUIC (quinn) トランスポート実装
    │   └── tcp_stream.rs       # TCP フォールバック実装
    └── platform/
        ├── mod.rs              # PlatformService トレイト + ファクトリ
        ├── android.rs          # Android フォアグラウンドサービス + JNI エクスポート
        ├── ios.rs              # iOS バックグラウンドタスク + C FFI エクスポート
        └── desktop.rs          # デスクトップ no-op
```
