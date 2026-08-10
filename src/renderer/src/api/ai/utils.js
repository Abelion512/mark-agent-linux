import { getAllConfig } from '../db'
import { marked } from 'marked'

export const getCurrentTimeInfo = (dateObj = new Date()) => {
  const options = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  }
  return dateObj.toLocaleDateString('id-ID', options)
}




export const playVoice = async (text, onStart, onEnd) => {
  try {
    const config = await getAllConfig()
    const rate = config[0]?.ttsRate ?? 0
    const pitch = config[0]?.ttsPitch ?? 0

    // 1. Minta data audio (base64) ke backend
    const audioBase64 = await window.api.textToSpeech(text, rate, pitch)

    if (audioBase64) {
      // 2. Bikin object Audio baru dari string base64 tadi
      const audio = new Audio(audioBase64)

      audio.onended = () => {
        window.isMarkSpeaking = false
        if (onEnd) onEnd()
      }

      // 3. Mainkan!
      window.isMarkSpeaking = true
      await audio.play()
      if (onStart) onStart()
    } else {
      if (onStart) onStart()
      if (onEnd) onEnd()
    }
  } catch (error) {
    console.error('Gagal memutar suara:', error)
    if (window.api && window.api.showNotification) {
      window.api.showNotification('Error TTS', String(error.message || error))
    }
    window.isMarkSpeaking = false
    if (onStart) onStart()
    if (onEnd) onEnd()
  }
}

// ==========================================
// TELEGRAM UTILS
// ==========================================
export const formatForTelegram = (text) => {
  if (!text) return ''
  return text.trim()
}

// ==========================================
// PLANNING (AGENTIC) FUNCTIONS
// ==========================================
