export const RULER_HEIGHT = 32
export const VIDEO_ROW_HEIGHT = 88
export const VIDEO_TRACK_TOP = RULER_HEIGHT + 8
export const VIDEO_TRACK_HEIGHT = 72
export const ANNOTATION_ROW_HEIGHT = 48
export const AUDIO_ROW_HEIGHT = 64
export const SUBTITLE_ROW_HEIGHT = 40

export function audioTrackTop(hasAnnotations: boolean) {
  return RULER_HEIGHT + VIDEO_ROW_HEIGHT + (hasAnnotations ? ANNOTATION_ROW_HEIGHT : 0) + 8
}

export function subtitleTrackTop(hasAnnotations: boolean, hasAudio: boolean) {
  return audioTrackTop(hasAnnotations) + (hasAudio ? AUDIO_ROW_HEIGHT : 0)
}
