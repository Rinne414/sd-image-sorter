# Release Notes - v3.0.2

## Highlights

- NVIDIA GPUs with more than 4 GB of VRAM now report their true total in the Tagger modal. The previous value was capped at 4095 MB because Windows' `Win32_VideoController.AdapterRAM` is a 32-bit DWORD.
- Batch-size recommendations now reflect actual VRAM. On an RTX 3090 the Auto runtime now picks batch size 32 (low risk) instead of batch size 8.
- Dual-NVIDIA rigs match each card to its own VRAM by name, so the 3090 never borrows the 3060's numbers when WMI and nvidia-smi enumerate in different orders.

## What Was Actually Broken

- `backend/hardware_monitor.py` enumerated GPUs via WMI and, if `torch.cuda` was unavailable (the portable install ships a CPU-only torch wheel), surfaced the 4095 MB cap to the Tagger modal. ONNX Runtime CUDA inference was never affected — only the VRAM readout and the batch-size suggestion.
- The fix overlays `nvidia-smi --query-gpu=name,memory.total,memory.free` on top of the WMI result, keyed by device name (with positional fallback for identical cards).

## User Experience Improvements

- Users on RTX 3090 / 4090 / 5090-class cards no longer see "4095MB VRAM" with a conservative batch-size 8 recommendation.
- Multi-GPU users (e.g., RTX 3090 + RTX 3060) now get per-card VRAM even when the two tools disagree on enumeration order.
- When `nvidia-smi` is missing (no NVIDIA driver, or PATH does not resolve it), the old 4095 MB safe-default path is preserved — no crash, just the previous conservative behavior.

## Verified Before Release

- Backend test suite: `450 passed, 2 skipped`
- New regression coverage in `backend/tests/test_hardware_monitor.py` — 5 tests:
  - WMI 4 GB cap override on single-NVIDIA-plus-iGPU
  - Recommendation pipeline on 24 GB of VRAM
  - Degraded fallback when nvidia-smi is unavailable
  - Dual-NVIDIA name match when WMI and nvidia-smi disagree on order
  - Non-NVIDIA devices are never overwritten with nvidia-smi values
- Live hardware check on an RTX 3090 with CPU-only torch: `24576 MB total / 21617 MB free → batch_size=32, risk=low`.

## Release Assets

- `sd-image-sorter-v3.0.2-windows-portable.zip`
- `sd-image-sorter-v3.0.2-linux-mac.tar.gz`
- Optional model asset packs (unchanged from v3.0.1 — see [RELEASE_PACKS.md](./RELEASE_PACKS.md)).

## Honest Limitations

- Accurate NVIDIA VRAM detection relies on the `nvidia-smi` executable, which ships with any current NVIDIA driver. On systems without it, the readout falls back to the WMI 4095 MB value and the recommendation stays conservative.
- Non-NVIDIA GPUs (Intel, AMD) still rely on the WMI reading; their 32-bit cap is unaddressed because no vendor-neutral tool equivalent to `nvidia-smi` is available across both.
