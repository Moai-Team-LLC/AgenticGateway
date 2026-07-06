/**
 * VENDORED — do not edit. Re-sync with `bun run scripts/sync-vendor.ts`.
 *
 * Source:  AgenticPerformance (APL) `packages/core/src/eval/mining.ts`
 *          (the deterministic hash-based sampling primitive)
 * Commit:  d88f049b85b00df88f079347d9a64ae62568dea7
 * License: Apache-2.0 (Moai Team LLC)
 * Changes: excerpt — only `hashUnit` is vendored (the golden-set split
 *          helpers around it are APL-internal).
 *
 * Why vendored: sampled judging must be deterministic per request id, the
 * same way APL's train/gate split is deterministic per case id — same
 * primitive, same behavior (ADR-0002).
 */

import { createHash } from "node:crypto"

/** Deterministic [0,1) from an id (sha256 → first 32 bits). Shared by the split helpers. */
export const hashUnit = (id: string): number =>
  createHash("sha256").update(id).digest().readUInt32BE(0) / 0x1_0000_0000
