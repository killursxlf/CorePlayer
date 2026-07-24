import { create } from "zustand"
import type { RuntimePerformanceConfig } from "@/types/media"

type PerformanceStore = {
  config: RuntimePerformanceConfig | null
  setConfig: (config: RuntimePerformanceConfig) => void
}

export const usePerformanceStore = create<PerformanceStore>((set) => ({
  config: null,
  setConfig: (config) => set({ config }),
}))
