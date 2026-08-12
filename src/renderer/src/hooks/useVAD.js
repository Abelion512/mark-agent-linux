import { useState, useRef, useEffect } from 'react'
import { transcribeAudioGroq } from '../api/groq'
import { getAllConfig } from '../api/db'

export const useVAD = ({
  onTranscript // Function to call when STT finishes
}) => {
  const [isRecording, setIsRecording] = useState(false)
  const [toastMessage, setToastMessage] = useState('')

  const streamRef = useRef(null)
  const audioContextRef = useRef(null)
  const processorRef = useRef(null)
  const isSpeakingRef = useRef(false)
  const audioChunksRef = useRef([])
  const isStartingRef = useRef(false)
  const isRecordingRef = useRef(false)
  const silenceFramesRef = useRef(0)
  const isProcessingSpeechRef = useRef(false)

  const stopVADCleanup = () => {
    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    isSpeakingRef.current = false
    audioChunksRef.current = []
    isRecordingRef.current = false
    setIsRecording(false)
    isStartingRef.current = false
    silenceFramesRef.current = 0
    isProcessingSpeechRef.current = false
  }

  const finishSpeechAndTranscribe = () => {
    if (isProcessingSpeechRef.current) return
    isProcessingSpeechRef.current = true

    const totalLength = audioChunksRef.current.reduce((acc, val) => acc + val.length, 0)
    if (totalLength < 8000) {
      stopVADCleanup()
      return
    }

    const merged = new Float32Array(totalLength)
    let offset = 0
    for (let arr of audioChunksRef.current) {
      merged.set(arr, offset)
      offset += arr.length
    }

    // Trim trailing silence (~1.5s = 24000 samples at 16kHz) to avoid Whisper hallucinations
    const trimLength = Math.max(8000, merged.length - 24000)
    const trimmedAudio = merged.subarray(0, trimLength)

    stopVADCleanup()

    transcribeAudioGroq(trimmedAudio)
      .then((text) => {
        if (text && text.trim() !== '') {
          onTranscript(text.trim())
        }
      })
      .catch((err) => {
        console.error('[VAD] Groq Error:', err)
        if (err.message && err.message.includes('Key')) {
          setToastMessage(err.message)
          setTimeout(() => setToastMessage(''), 5000)
        }
      })
  }

  const startVADRecording = async () => {
    if (isStartingRef.current || isRecordingRef.current) return
    isStartingRef.current = true

    let isActive = true
    const currentStopVAD = stopVADCleanup

    try {
      stopVADCleanup()
      isStartingRef.current = true

      const config = await getAllConfig()
      if (!isActive || !isStartingRef.current) return

      const micId = config[0]?.micDeviceId
      const constraints = {
        audio: micId && micId !== 'default' ? { deviceId: { exact: micId } } : true
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      if (!isActive || !isStartingRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      streamRef.current = stream

      const AudioContext = window.AudioContext || window.webkitAudioContext
      const audioContext = new AudioContext({ sampleRate: 16000 })
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor

      const gainNode = audioContext.createGain()
      gainNode.gain.value = 0 // Mute output

      source.connect(processor)
      processor.connect(gainNode)
      gainNode.connect(audioContext.destination)

      isRecordingRef.current = true
      setIsRecording(true)
      silenceFramesRef.current = 0

      // Each buffer is 4096 samples at 16000Hz = 0.256s (256ms)
      // 6 frames silence = ~1.5s silence
      const MAX_SILENCE_FRAMES = 6
      const RMS_THRESHOLD = 0.018 // Slightly higher threshold to ignore background laptop fan/mic noise

      processor.onaudioprocess = (e) => {
        if (window.isMarkSpeaking || isProcessingSpeechRef.current) return

        const input = e.inputBuffer.getChannelData(0)
        let sum = 0
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
        const rms = Math.sqrt(sum / input.length)

        if (rms > RMS_THRESHOLD) {
          if (!isSpeakingRef.current) {
            isSpeakingRef.current = true
            audioChunksRef.current = []
          }
          silenceFramesRef.current = 0
          audioChunksRef.current.push(new Float32Array(input))
        } else if (isSpeakingRef.current) {
          // Push low audio chunk so end of word isn't clipped
          audioChunksRef.current.push(new Float32Array(input))
          silenceFramesRef.current += 1

          // Total recording length check (hard max 15 seconds)
          const totalSamples = audioChunksRef.current.reduce((acc, val) => acc + val.length, 0)
          if (silenceFramesRef.current >= MAX_SILENCE_FRAMES || totalSamples >= 240000) {
            finishSpeechAndTranscribe()
          }
        }
      }
      isStartingRef.current = false
    } catch (error) {
      console.error('[VAD] Error starting mic:', error)
      currentStopVAD()
      setToastMessage('Gagal mengakses mikrofon.')
      setTimeout(() => setToastMessage(''), 5000)
    }
  }

  useEffect(() => {
    window.isVADRecording = isRecording
  }, [isRecording])

  const toggleRecording = () => {
    if (isRecordingRef.current) {
      finishSpeechAndTranscribe()
    } else {
      startVADRecording()
    }
  }

  useEffect(() => {
    return () => stopVADCleanup()
  }, [])

  return { isRecording, toggleRecording, toastMessage }
}
