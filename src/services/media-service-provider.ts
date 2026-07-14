import { isTauri } from "@tauri-apps/api/core"
import { mockMediaService } from "@/services/mock-media-service"
import type { MediaService } from "@/services/media-service"
import { tauriMediaService } from "@/services/tauri-media-service"

export function getMediaService(): MediaService {
  return isTauri() ? tauriMediaService : mockMediaService
}
