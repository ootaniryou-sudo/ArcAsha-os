# Akasha Wire Protocol — Binary Packet Spec

JSON is **forbidden** on the data plane. All mesh traffic is a single `ArrayBuffer`
with a fixed 48-byte header and an optional `Float32Array` payload (activations /
hidden states) that can be uploaded straight to WebGPU.

## Byte Layout

| Offset | Size | Type   | Field         | Notes                                      |
|-------:|-----:|--------|---------------|--------------------------------------------|
| 0      | 4    | u32 BE | `MAGIC`       | `0x414B5348` (`AKSH`)                      |
| 4      | 1    | u8     | `VERSION`     | currently `1`                              |
| 5      | 1    | u8     | `COMMAND`     | see Command table                          |
| 6      | 2    | u16 LE | `FLAGS`       | bitfield (`SHADOW`, `FINAL`, `URGENT`)     |
| 8      | 8    | u64 LE | `TX_ID`       | inference transaction id                   |
| 16     | 8    | u64 LE | `NODE_ID`     | edge device id                             |
| 24     | 4    | u32 LE | `CLUSTER_ID`  | semantic expert cluster                    |
| 28     | 4    | u32 LE | `PAYLOAD_LEN` | payload bytes (multiple of 4)              |
| 32     | 8    | u64 LE | `TIMESTAMP_US`| dispatch time (µs, hrtime)                 |
| 40     | 4    | u32 LE | `EXPECTED_US` | timeout budget hint (µs)                   |
| 44     | 4    | u32 LE | `SEQ`         | sequence / shadow hint                     |
| **48** | N    | f32[]  | `PAYLOAD`     | raw activations for WebGPU                 |

`HEADER_SIZE = 48`. Maximum payload floats = 65 536 (256 KiB).

## Commands

| Code | Name           | Direction        | Payload                |
|-----:|----------------|------------------|------------------------|
| 0x01 | `REGISTER`     | Edge → Master    | empty                  |
| 0x02 | `HEARTBEAT`    | Edge → Master    | empty                  |
| 0x03 | `COMPUTE_TASK` | Master → Edge    | `Float32Array` tensor  |
| 0x04 | `RESULT`       | Edge → Master    | `Float32Array` tensor  |
| 0x05 | `FAILOVER`     | Master → Shadow  | same tensor as primary |
| 0x06 | `ACK`          | either           | empty                  |
| 0x07 | `DEREGISTER`   | Edge → Master    | empty                  |
| 0x08 | `BENCHMARK`    | Master → Edge    | f32 probe tensor       |
| 0x09 | `ASSIGN`       | Master → Edge    | role + cluster + telemetry |
| 0x0A | `RELAY`        | Edge → Edge†     | `Float32Array` activation |
| 0x0B | `TOKEN_OUT`    | Edge → Master    | `Float32Array` logits  |

† RELAY may be proxied through the master when the edge cannot open a server socket.

## Flags

| Bit | Name     | Meaning                                      |
|----:|----------|----------------------------------------------|
| 0   | `SHADOW` | packet is a failover replica                 |
| 1   | `FINAL`  | last hop / pipeline terminal                 |
| 2   | `URGENT` | prioritize in edge scheduler                 |

## Cluster IDs

| ID | Name            |
|---:|-----------------|
| 1  | `general_expert`|
| 2  | `math_expert`   |
| 3  | `code_expert`   |
| 4  | `language_expert`|
| 99 | `shadow_pool`   |

## Threading & IPC

```
┌─────────────┐   control SAB    ┌────────────────┐  inbound SAB   ┌─────────────────┐
│ Main Thread │ ───────────────► │ Router Worker  │ ◄───────────── │ Network Worker  │
│ submitPrompt│                  │ O(1) IdlePool  │ ──────────────► │ WebSocket mesh  │
└─────────────┘                  │ FaultTolerance │  outbound SAB  └─────────────────┘
                                 └────────────────┘
```

SPSC lock-free rings over `SharedArrayBuffer`:
- bytes `[0..3]` head (producer), `[4..7]` tail (consumer)
- each slot: `[u32 length][payload…]`

## Fault Tolerance

Deadline = `EWMA(latency_us) + margin_us` (default margin **+2000 µs**).
On breach, the same binary tensor is fan-out to a shadow node (`Flag.SHADOW`).
First `RESULT` wins; the loser is dropped (idempotent `txId`).
