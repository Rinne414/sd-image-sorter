// Responses the About tab reads. These routes have no response_model, so the
// shapes are written here from the backend code they come from.

/** GET /api/system-info → system_info (hardware_monitor.py `_collect_system_info`). */
export interface SystemInfo {
  total_ram_gb?: number | null
  available_ram_gb?: number | null
  gpu_name?: string | null
  gpu_vram_total_mb?: number | null
  gpu_vram_available_mb?: number | null
  torch_cuda_available?: boolean
  cpu_count?: number | null
  os_platform?: string | null
  onnx_providers?: string[]
  gpu_devices?: { name?: string | null }[]
  /** Set instead of the rest when the probe failed. */
  error?: string
}

export interface SystemInfoResponse {
  system_info?: SystemInfo
}

/** GET /api/updates/channel (services/update_service_channel.py `get_channel_settings`). */
export interface ChannelSettings {
  channel_name?: string
  download_url_prefix?: string
  has_channel_override?: boolean
  is_default_github_channel?: boolean
}

/** The two fields of GET /api/stats the About tab shows. */
export interface AppStats {
  app_version?: string
  github_url?: string
}
