import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { MediaService } from "@/services/media-service"
import { toMediaServiceError } from "@/services/media-service"
import { useMediaStore } from "@/stores/media-store"

export type PlaybackCopyState = {
  source: string | null
  status: "idle" | "preparing" | "ready" | "switching" | "error"
  path?: string
  active: boolean
  autoUse?: boolean
  error?: string
}
const idle: PlaybackCopyState = { source: null, status: "idle", active: false }

export function usePlaybackProxy(service: MediaService, source: string | null, videoId: string | null,
  session: number, autoPrepare: boolean, playing: boolean, onSwitch: (url: string) => void) {
  const [state, setState] = useState<PlaybackCopyState & { session: number }>({ ...idle, session })
  const generation = useRef(0)
  const attempted = useRef<string | null>(null)
  const recovered = useRef<string | null>(null)
  const current = useMemo(() => state.source === source && state.session === session ? state : { ...idle, session }, [state, source, session])
  if (state.source !== source || state.session !== session) setState({ ...idle, source, session })

  useEffect(() => {
    attempted.current = null
    recovered.current = null
    const invalidate = () => { generation.current++ }
    return () => {
      invalidate()
      void service.cancelBackgroundMedia(true).catch(() => undefined)
    }
  }, [service, source, session])

  const start = useCallback(async (forceCpu = false) => {
    if (!source || !videoId) return
    const job = ++generation.current
    attempted.current = source
    setState({ source, session, status: "preparing", active: false })
    try {
      const path = await service.generatePlaybackProxy(source, videoId, forceCpu)
      if (job !== generation.current || useMediaStore.getState().originalPath !== source) return
      setState({ source, session, status: "ready", path, active: false, autoUse: true })
    } catch (error) {
      if (job !== generation.current) return
      const details = toMediaServiceError(error)
      setState({ source, session, status: "error", active: false, error: details.technicalDetails || details.message })
    }
  }, [service, source, videoId, session])

  const recover = useCallback(() => {
    if (!source || recovered.current === source || current.status === "preparing") return
    recovered.current = source
    void start(true)
  }, [source, current.status, start])

  const cancel = useCallback(() => {
    generation.current++
    setState({ ...idle, source, session })
    void service.cancelBackgroundMedia(true).catch(() => undefined)
  }, [service, source, session])

  const toggle = useCallback(async () => {
    if (!source || !current.path || current.status !== "ready") return
    const job = ++generation.current
    const nextActive = !current.active
    setState({ ...current, status: "switching", autoUse: false })
    try {
      const url = await service.preparePlayback(nextActive ? current.path : source)
      if (job !== generation.current || useMediaStore.getState().originalPath !== source) {
        await service.closeMedia(url)
        return
      }
      const previous = useMediaStore.getState().playbackUrl
      onSwitch(url)
      setState({ ...current, status: "ready", active: nextActive, autoUse: false })
      if (previous) await service.closeMedia(previous).catch(() => undefined)
    } catch (error) {
      if (job !== generation.current) return
      const details = toMediaServiceError(error)
      setState({ ...current, status: "ready", autoUse: false, error: details.technicalDetails || details.message })
    }
  }, [current, onSwitch, service, source])

  useEffect(() => {
    if (!autoPrepare || !source || !videoId || attempted.current === source) return
    const timer = window.setTimeout(() => { void start() }, 0)
    return () => window.clearTimeout(timer)
  }, [autoPrepare, source, start, videoId])

  // Switch automatically at rest so completing a background encode cannot interrupt Play.
  useEffect(() => {
    if (playing || current.status !== "ready" || !current.autoUse) return
    const timer = window.setTimeout(() => { void toggle() }, 0)
    return () => window.clearTimeout(timer)
  }, [playing, current.status, current.autoUse, toggle])

  return { state: current, start, cancel, toggle, recover }
}
