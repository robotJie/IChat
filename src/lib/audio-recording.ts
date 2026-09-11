export interface AudioRecording {
  stop(): Promise<Blob>
  cancel(): void
}

export const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true }

export function encodeMonoWav(buffer: AudioBuffer): Blob {
  const frames = buffer.length
  const wav = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(wav)
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, "RIFF")
  view.setUint32(4, 36 + frames * 2, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, frames * 2, true)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  for (let i = 0; i < frames; i++) {
    const sample = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length))
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  return new Blob([wav], { type: "audio/wav" })
}

export async function startAudioRecording(signal: AbortSignal, onInterrupted: () => void): Promise<AudioRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MICROPHONE_CONSTRAINTS })
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop())
  if (signal.aborted) {
    stopTracks()
    signal.throwIfAborted()
  }
  let recorder: MediaRecorder
  try {
    const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type))
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (error) {
    stopTracks()
    throw error
  }
  let chunks: Blob[] = []
  let finishing = false
  let cancelled = false
  let rejectStop: ((reason: unknown) => void) | null = null
  let stopPromise: Promise<Blob> | null = null
  const interrupted = () => {
    if (!finishing && !cancelled) onInterrupted()
  }
  stream.getTracks().forEach((track) => track.addEventListener("ended", interrupted))
  const detach = () => {
    signal.removeEventListener("abort", cancel)
    stream.getTracks().forEach((track) => track.removeEventListener("ended", interrupted))
  }
  const cancel = () => {
    cancelled = true
    detach()
    recorder.ondataavailable = recorder.onstop = recorder.onerror = null
    if (recorder.state !== "inactive") recorder.stop()
    stopTracks()
    chunks = []
    rejectStop?.(new DOMException("Recording cancelled", "AbortError"))
  }
  signal.addEventListener("abort", cancel, { once: true })
  recorder.ondataavailable = (event) => {
    if (!cancelled && event.data.size) chunks.push(event.data)
  }
  recorder.onerror = interrupted
  recorder.onstop = interrupted
  try {
    recorder.start(250)
  } catch (error) {
    cancel()
    throw error
  }
  return {
    cancel,
    stop() {
      if (stopPromise) return stopPromise
      if (cancelled || signal.aborted) return Promise.reject(new DOMException("Recording cancelled", "AbortError"))
      finishing = true
      stopPromise = new Promise<Blob>((resolve, reject) => {
        rejectStop = reject
        recorder.onerror = () => { cancel(); onInterrupted() }
        recorder.onstop = () => {
          detach()
          stopTracks()
          const audio = new Blob(chunks, { type: recorder.mimeType })
          chunks = []
          void (async () => {
            const encoded = await audio.arrayBuffer()
            signal.throwIfAborted()
            // decodeAudioData resamples to this context's rate. No audio is played.
            const decoder = new OfflineAudioContext(1, 1, 16000)
            const buffer = await decoder.decodeAudioData(encoded)
            signal.throwIfAborted()
            resolve(encodeMonoWav(buffer))
          })().catch(reject)
        }
        recorder.stop()
        stopTracks()
      })
      return stopPromise
    }
  }
}
