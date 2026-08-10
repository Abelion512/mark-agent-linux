import { useState, useEffect } from 'react'
import MarkHome from './pages/MarkHome'
import Configuration from './pages/Configuration'
import LiveAudio from './pages/LiveAudio'
import TelegramBot from './pages/TelegramBot'
import Plugins from './pages/Plugins'
import Knowledge from './pages/Knowledge'
import Guidebook from './pages/Guidebook'
import RelationalGrowth from './pages/RelationalGrowth'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { ChatProvider } from './contexts/ChatContext'
import { YoutubeMusicProvider } from './contexts/YoutubeMusicContext'
import { ApprovalProvider } from './contexts/ApprovalContext'
import { YoutubeMusicPlayer } from './components/YoutubeMusicPlayer'
import { GlobalCameraManager } from './components/GlobalCameraManager'
import { getAllConfig } from './api/db'

const GlobalListener = () => {
  const navigate = useNavigate()

  useEffect(() => {
    const handleShortcut = () => {
      // Navigate to Home (MarkHome) and trigger microphone auto-start
      navigate('/', { state: { autoStartMic: Date.now() } })
    }

    if (window.api?.onLiveAudioShortcut) {
      window.api.onLiveAudioShortcut(handleShortcut)
    }

    if (window.api?.onTgRequestAgentExecution) {
      window.api.onTgRequestAgentExecution((data) => {
        window.dispatchEvent(new CustomEvent('tg-admin-message', { detail: data }))
      })
    }

    return () => {
      if (window.api?.removeLiveAudioShortcut) {
        window.api.removeLiveAudioShortcut()
      }
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.removeAllListeners('route-to-config')
        window.electron.ipcRenderer.removeAllListeners('tg:request-agent-execution')
      }
    }
  }, [navigate])

  return null
}

import { initOramaIndices, hydrateFromDexie } from './api/oramaStore'

function App() {
  const [hasConfig, setHasConfig] = useState(true)
  const [isChecking, setIsChecking] = useState(true)
  const [loadingText, setLoadingText] = useState('Membangunkan Mark...')

  useEffect(() => {
    const checkConfig = async () => {
      // 1. Init Orama and Hydrate from Dexie
      try {
        setLoadingText('Memuat Knowledge Base...')
        await initOramaIndices()
        await hydrateFromDexie()
        console.log('[App] Orama indices ready!')
      } catch (e) {
        console.error('[App] Failed to init Orama:', e)
      }

      // 1.5 Load Embeddings Model
      try {
        setLoadingText('Memuat Memori Kognitif...')
        const { getExtractor } = await import('./api/vectorMemory')
        let memStats = {}
        await getExtractor((info) => {
          if (info.status === 'initiate') {
            memStats[info.file] = { loaded: 0, total: info.total || 0 }
          } else if (info.status === 'progress') {
            if (memStats[info.file]) {
              memStats[info.file].loaded = info.loaded
              memStats[info.file].total = info.total
            }
            const values = Object.values(memStats)
            const totalBytes = values.reduce((acc, curr) => acc + curr.total, 0)
            const loadedBytes = values.reduce((acc, curr) => acc + curr.loaded, 0)
            if (totalBytes > 0) {
              const percent = Math.round((loadedBytes / totalBytes) * 100)
              const loadedMB = (loadedBytes / 1024 / 1024).toFixed(1)
              const totalMB = (totalBytes / 1024 / 1024).toFixed(1)
              setLoadingText(`Mengunduh Memori AI... ${percent}% (${loadedMB}MB / ${totalMB}MB)`)
            }
          } else if (info.status === 'done' || info.status === 'ready') {
            setLoadingText('Membangunkan Mark...')
          }
        })
      } catch (e) {
        console.error('[App] Failed to load Transformers:', e)
      }

      // 2. Load config
      const data = await getAllConfig()
      if (!data || data.length === 0) {
        setHasConfig(false)
      } else {
        setHasConfig(true)
        if (window.api && window.api.syncConfig) {
          window.api.syncConfig(data[0])
        }
      }
      setIsChecking(false)
    }
    checkConfig()
  }, [])

  if (isChecking) {
    return (
      <div className="h-screen w-screen bg-base-300 flex flex-col items-center justify-center gap-5">
        <span className="loading loading-infinity w-16 text-primary"></span>
        <p className="text-sm font-semibold tracking-[0.2em] text-white/40 uppercase animate-pulse">
          {loadingText}
        </p>
      </div>
    )
  }

  if (!hasConfig) {
    return <Configuration isFirstSetup={true} onSetupComplete={() => window.location.reload()} />
  }

  const isStandalone = window.location.hash.includes('telegram-bot')

  return (
    <ApprovalProvider>
      <YoutubeMusicProvider>
        <ChatProvider>
          <HashRouter>
            <GlobalListener />
            <div className="h-screen flex flex-col overflow-hidden">
              <div className="h-screen w-full">
                <Routes>
                  <Route path="/" element={<MarkHome />} />
                  <Route path="/config" element={<Configuration />} />
                  <Route path="/plugins" element={<Plugins />} />
                  <Route path="/live-audio" element={<LiveAudio />} />
                  <Route path="/telegram-bot" element={<TelegramBot />} />
                  <Route path="/knowledge" element={<Knowledge />} />
                  <Route path="/guidebook" element={<Guidebook />} />
                  <Route path="/relational" element={<RelationalGrowth />} />
                </Routes>
              </div>
            </div>
            <div style={{ display: isStandalone ? 'none' : 'block' }}>
              <YoutubeMusicPlayer />
            </div>
            <GlobalCameraManager />
            <webview
              id="global-ai-search-webview"
              src="about:blank"
              useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
              style={{ display: 'none' }}
            />
          </HashRouter>
        </ChatProvider>
      </YoutubeMusicProvider>
    </ApprovalProvider>
  )
}

export default App
