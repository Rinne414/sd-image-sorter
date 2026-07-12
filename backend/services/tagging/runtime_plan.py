"""Runtime planning: chunk-size constants and the adaptive runtime plan.

Moved verbatim from services/tagging_service.py (decomposition 2026-07).
"""

from typing import Any, Dict

from config import TAGGER_MODELS
from services.tagging.request import TagRequest

TRUE_BATCH_MODEL_MAX = 64
CPU_CHUNK_MAX = 64
CUSTOM_ONNX_GPU_START_CHUNK_MAX = 8
CUSTOM_ONNX_CPU_START_CHUNK_MAX = 8
TORIIGATE_GPU_CHUNK_MAX = 1
TORIIGATE_LOAD_HEARTBEAT_SECONDS = 5.0


def _format_runtime_adjustment_message(runtime_info: Dict[str, Any]) -> str:
    """Summarize adaptive runtime adjustments for the progress UI."""
    backoff_steps = runtime_info.get("backoff_steps") or []
    if not backoff_steps:
        return ""

    parts = []
    for step in backoff_steps:
        mode = step.get("mode")
        from_size = step.get("from")
        to_size = step.get("to")
        if mode == "gpu_backoff":
            parts.append(f"GPU batch {from_size}->{to_size}")
        elif mode == "cpu_fallback":
            parts.append(f"GPU batch {from_size}->CPU fallback")

    final_chunk_size = runtime_info.get("final_chunk_size")
    if runtime_info.get("used_cpu_fallback"):
        parts.append("continued on CPU")
    elif final_chunk_size:
        parts.append(f"current chunk {final_chunk_size}")
    return ", ".join(parts)


class RuntimePlanMixin:
    """Runtime-plan slice of TaggingService (assembled in services.tagging.service)."""

    def _build_runtime_plan(self, request: TagRequest) -> Dict[str, Any]:
        """Translate a public tag request into a high-throughput runtime plan with adaptive safety."""
        from hardware_monitor import get_system_info, recommend_tagger_config

        model_name = self._resolve_model_name(request)
        model_config = TAGGER_MODELS.get(model_name, {})
        runtime_backend = str(model_config.get("runtime_backend", "wd14")).lower()
        effective_use_gpu = bool(request.use_gpu)
        startup_notice = ""
        fetch_batch_size = 16 if effective_use_gpu else 8
        commit_interval = fetch_batch_size
        gc_interval = max(4, fetch_batch_size)
        cpu_pause_seconds = 0.0
        session_refresh_interval = 180 if effective_use_gpu else 0
        requested_chunk_size = int(request.batch_size) if request.batch_size else None

        system_info = get_system_info()
        hardware_rec = recommend_tagger_config(
            system_info, model_name=model_name, use_gpu=effective_use_gpu
        )

        custom_runtime_notice = ""
        if request.model_path:
            custom_runtime_notice = (
                "Custom ONNX model on GPU. Automatic hardware clamps stay active, but the app starts from a conservative runtime chunk until this model proves stable."
                if effective_use_gpu
                else "Custom ONNX model on CPU. Switch GPU back on when you want acceleration."
            )

        if runtime_backend == "toriigate":
            if effective_use_gpu:
                fetch_batch_size = 1
                session_refresh_interval = 0
                startup_notice = (
                    "ToriiGate runs through the multimodal caption backend. "
                    "GPU is strongly recommended, and runtime chunk size is fixed to 1 to limit VRAM usage."
                )
            else:
                fetch_batch_size = 1
                cpu_pause_seconds = 0.0
                session_refresh_interval = 0
                startup_notice = "ToriiGate is running on CPU. This is valid but much slower than the CUDA path."
        elif effective_use_gpu:
            fetch_batch_size = int(
                hardware_rec.get("recommended_batch_size") or fetch_batch_size
            )
            session_refresh_interval = int(
                hardware_rec.get("recommended_session_refresh_interval")
                or session_refresh_interval
            )
        else:
            fetch_batch_size = min(
                CPU_CHUNK_MAX,
                max(1, int(hardware_rec.get("recommended_cpu_chunk_size") or 12)),
            )
            # Release the ONNX CPU memory arena (+ gc) every N images on long CPU runs, the
            # same way the GPU path refreshes every 180. Without this the CPU mem arena grows
            # unbounded across a big batch; combined with 100%-pinned cores it stresses
            # marginal hardware (observed: a whole-machine freeze / 0x124 CPU machine-check
            # on a ~110-image eva02 CPU run). recommend_tagger_config may already suggest a
            # value; fall back to 100.
            session_refresh_interval = int(
                hardware_rec.get("recommended_session_refresh_interval") or 100
            )
            # Brief pause between chunks so we don't hold every core at 100% for the whole
            # run (gives the CPU/PSU/thermals headroom on marginal rigs).
            cpu_pause_seconds = 0.02 if fetch_batch_size >= 12 else 0.01

        if request.model_path:
            custom_start_cap = (
                CUSTOM_ONNX_GPU_START_CHUNK_MAX
                if effective_use_gpu
                else CUSTOM_ONNX_CPU_START_CHUNK_MAX
            )
            fetch_batch_size = min(fetch_batch_size, custom_start_cap)
        elif runtime_backend == "toriigate":
            fetch_batch_size = min(
                fetch_batch_size, TORIIGATE_GPU_CHUNK_MAX if effective_use_gpu else 1
            )

        if requested_chunk_size:
            safety_cap = int(
                hardware_rec.get("recommended_batch_size")
                if effective_use_gpu
                else hardware_rec.get("recommended_cpu_chunk_size") or fetch_batch_size
            )
            if runtime_backend == "toriigate":
                chunk_cap = TORIIGATE_GPU_CHUNK_MAX if effective_use_gpu else 1
            else:
                chunk_cap = TRUE_BATCH_MODEL_MAX if effective_use_gpu else CPU_CHUNK_MAX
            applied_chunk_size = max(
                1, min(requested_chunk_size, chunk_cap, max(1, safety_cap))
            )
            if applied_chunk_size != requested_chunk_size:
                clamp_notice = (
                    f"Requested runtime chunk size {requested_chunk_size} was reduced to {applied_chunk_size} "
                    "to stay inside the supported runtime range."
                )
                startup_notice = f"{startup_notice} {clamp_notice}".strip()

            fetch_batch_size = applied_chunk_size
        elif request.model_path:
            startup_notice = custom_runtime_notice
        elif runtime_backend == "toriigate":
            startup_notice = startup_notice or (
                "ToriiGate uses the multimodal caption runtime. The app forces queue chunk 1 so long runs stay stable."
            )
        elif effective_use_gpu:
            startup_notice = "Auto runtime is using the highest batched throughput this hardware profile should hold for long runs."
        else:
            startup_notice = (
                "CPU mode is using a larger worker chunk because true multi-image GPU batching "
                "is not active. Note: CPU tagging holds the processor busy for the whole run — "
                "for large batches or on a power/thermally marginal machine, GPU is the safer, "
                "faster path (it offloads the CPU and self-releases device memory periodically)."
            )

        commit_interval = max(1, min(fetch_batch_size, 10))
        gc_interval = max(4, min(fetch_batch_size, 8))

        runtime_request = request.model_copy(
            update={
                "use_gpu": effective_use_gpu,
                "allow_unsafe_acceleration": request.allow_unsafe_acceleration,
            }
        )

        return {
            "request": runtime_request.model_dump(mode="python"),
            "model_name": model_name,
            "effective_use_gpu": effective_use_gpu,
            "gpu_locked": False,
            "startup_notice": startup_notice,
            "fetch_batch_size": fetch_batch_size,
            "commit_interval": commit_interval,
            "gc_interval": gc_interval,
            "cpu_pause_seconds": cpu_pause_seconds,
            "session_refresh_interval": session_refresh_interval,
        }
