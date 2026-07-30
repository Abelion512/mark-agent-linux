import { useEffect, useRef } from 'react'
import { getNextAction } from '../../api/ai/planning'
import { getYoutubeSummary } from '../../api/ai/tools'
import { fetchAI } from '../../api/ai/core'
import { playVoice, getCurrentTimeInfo } from '../../api/ai/utils'
import { insertMemory, updateMemory, deleteMemory, getAllMemory } from '../../api/db'
import {
  getUnifiedContext,
  searchExtendedMemory,
  generateVector,
  cosineSimilarity
} from '../../api/vectorMemory'
import { searchMemoriesInOrama } from '../../api/oramaStore'

export const useMarkPlan = ({
  chatData,
  setChatData,
  config,
  isSpeak,
  abortControllerRef,
  setIsLoading,
  setIsAgentBusy,
  setMessage,
  handleYoutubeSearch,
  handleSearchCommand,
  handleYoutubeSummary,
  handleMusic,
  getYoutubeData,
  pushProcess,
  dismissProcess,
  activeTopic,
  setActiveTopic,
  currentMusicTrack,
  requestApproval,
  requestCameraCapture
}) => {
  // Listener for 'ai-status' events from Main Process (via IPC)
  useEffect(() => {
    if (window.api && window.api.onAiStatus) {
      window.api.onAiStatus((msg) => {
        setChatData((prev) => {
          const filtered = prev.filter((item) => !item.isThinking)
          return [...filtered, { role: 'ai', content: msg, isThinking: true }]
        })
      })
    }
  }, [setChatData])

  const isExecutingRef = useRef(false)
  const interventionBufferRef = useRef([])
  const lastUserPromptRef = useRef('')

  const handleIntervention = (msg) => {
    interventionBufferRef.current.push(msg)
  }

  const handlePlanningCommand = async (
    userInput,
    waContext = null,
    isAutonomous = false,
    autonomousInitialMessage = null,
    options = {},
    isSystem = false
  ) => {
    if (!waContext && isExecutingRef.current) {
      console.log('[useMarkPlan] Menolak prompt masuk karena proses lain sedang berjalan (Lock active).')
      return
    }
    if (!waContext) {
      isExecutingRef.current = true
      interventionBufferRef.current = [] // Bersihkan sisa intervensi lama
    }
    const finalIsSpeak = options.forceSpeak !== undefined ? options.forceSpeak : isSpeak
    if (!userInput) {
      if (!waContext) isExecutingRef.current = false
      return
    }

    // Jangan blokir UI Desktop jika perintah datang dari background/WhatsApp
    if (!waContext && !isAutonomous) {
      setIsLoading(true)
      if (!isSystem) {
        lastUserPromptRef.current = userInput // Simpan prompt terakhir untuk dikembalikan ke input jika gagal/abort
        setMessage('') // Clear input box instantly upon sending
      }
    }
    setIsAgentBusy(true)

    const timestampStr = getCurrentTimeInfo()

    let finalContent = userInput
    if (isSystem) finalContent = `[SYSTEM INSTRUCTION]: ${userInput}`
    if (isAutonomous) finalContent = `[SISTEM INTERNAL - INISIATIF OTONOM]: Otak bawah sadarmu berinisiatif untuk melakukan tindakan berikut: "${userInput}". LAKUKAN TUGAS INI! Bicaralah seolah-olah kamu yang memiliki inisiatif itu sendiri tanpa disuruh. PENTING: DILARANG KERAS menggunakan tool 'os-*' (seperti os-control-open, os-click, os-type, dll) untuk interaksi PC secara otonom! Respons "answer"-mu HARUS SANGAT SINGKAT, santai, dan cuek (Maks 1-2 kalimat pendek). DILARANG KERAS menggunakan sapaan kaku (seperti "Yoi Mada") ATAU menawarkan bantuan di akhir kalimat! Boleh kosongkan (null) jika tidak perlu bicara.`

    const userMessage = {
      role: 'user',
      content: finalContent,
      timestamp: timestampStr,
      created_at: Date.now()
    }

    // ========== STEP 1: PERSIAPAN CHAT SESSION ==========
    const rawSession = [
      ...chatData
        .filter(
          (item) =>
            item.role !== 'command' && !item.isThinking && !item.isSearching && !item.isSummarizing
        )
        .map((item) => {
          let msgContent = item.content || ''
          if (item.role === 'ai' && item.executedTools && item.executedTools.length > 0) {
            const toolLog = item.executedTools
              .map(
                (t) =>
                  `  * [Tool: ${t.tool}] query: "${t.query || ''}" -> Hasil: ${t.resultSummary || 'OK'}`
              )
              .join('\n')
            msgContent = `[RIWAYAT EKSEKUSI TOOL YANG SUDAH DILAKUKAN DI TURN INI]:\n${toolLog}\n\n[JAWABAN AKHIR KE USER]:\n${item.content}`
          }
          return {
            role: item.role === 'ai' ? 'assistant' : 'user',
            content: msgContent,
            mood: item.mood,
            isProactive: item.isProactive,
            timestamp: item.timestamp
          }
        })
    ]
    let chatSession = []
    rawSession.forEach((item, index) => {
      if (index > 0 && item.role === chatSession[chatSession.length - 1].role) {
        chatSession[chatSession.length - 1].content += `\n ${item.content}`
      } else {
        chatSession.push(item)
      }
    })
    // Tetap bawa history pesan sebelumnya walaupun mode disableTools (misal saat boot greeting)
    // agar AI bisa menyapa dengan konteks ("sudah lama tidak ngobrol", dll)
    chatSession = [...chatSession].slice(-1 * (config[0]?.context || 10))
    chatSession = [...chatSession, userMessage]

    if (!isAutonomous && !isSystem) {
      setChatData((prev) => [...prev, userMessage])
    }
    abortControllerRef.current = new AbortController()
    const agenticProcessId = `agentic-${Date.now()}`

    try {
      // ========== STEP 2: AMBIL MEMORI & KONTEKS ==========

      const allMemory = await getAllMemory()
      let searchQuery = userInput
      if (chatSession.length > 0) {
        const lastMsg = chatSession[chatSession.length - 2]
        if (lastMsg.role === 'assistant' && lastMsg.content) {
          let lastAiText = lastMsg.content
          // Jika teks terlalu panjang, ambil awal dan akhirnya saja biar konteks awal (seperti judul lagu) gak hilang
          if (lastAiText.length > 600) {
            lastAiText = lastAiText.substring(0, 300) + ' ... ' + lastAiText.slice(-300)
          }
          searchQuery = `Konteks obrolan sebelumnya: "${lastAiText}". Pertanyaan user saat ini: "${userInput}"`
          console.log(searchQuery)
        }
      }
      const contextPromise = getUnifiedContext(searchQuery, allMemory)
      const abortPromise = new Promise((_, reject) => {
        const onAbort = () => reject(new Error('AbortError'))
        if (abortControllerRef.current.signal.aborted) return onAbort()
        abortControllerRef.current.signal.addEventListener('abort', onAbort)
      })
      const unifiedContext = await Promise.race([contextPromise, abortPromise])

      let contextMsgStr = ''

      if (waContext)
        contextMsgStr += `Permintaan ini berasal dari WhatsApp (JID: ${waContext.jid}).\n`
      if (isSystem)
        contextMsgStr += `[SYSTEM INSTRUCTION]: Pesan ini adalah instruksi internal dari sistem, bukan dari user.\n`
      if (isAutonomous)
        contextMsgStr += `[AWARENESS MODE]: Ini adalah pemikiran autonom-mu sendiri. Pesan terakhir di sesi ini BUKAN dari user, melainkan inisiatifmu sendiri. Saat memberikan 'answer' akhir ke user, berlakulah seolah-olah KAMU yang pertama kali membuka topik secara proaktif (misal: 'Eh, tadi gue iseng nyari info...'). JANGAN bertingkah seolah user yang menyuruhmu!\n`
      if (currentMusicTrack && currentMusicTrack.title) {
        contextMsgStr += `[STATUS SISTEM]: Sedang memutar "${currentMusicTrack.title}" oleh ${currentMusicTrack.artist}.\n`
      }

      // Inject window tracker — biar AI tau user lagi ngapain di PC
      try {
        const activityBuffer = await window.api.getActivityBuffer()
        if (activityBuffer && activityBuffer.length > 0) {
          const recent = activityBuffer.slice(-5) // Ambil 5 aktivitas terakhir saja biar hemat token
          const activitySummary = recent
            .map((a) => `[${a.time}] ${a.app}${a.title ? ` — ${a.title}` : ''}`)
            .join('\n')
          contextMsgStr += `[AKTIVITAS PC USER (terakhir)]\n${activitySummary}\n`
        }
      } catch (_) {
        /* Silent fail — jika API tidak tersedia */
      }

      // Jika AI memiliki inisiatif (autonomous), tampilkan pesannya sebagai chat permanen sebelum masuk loop mikir
      if (isAutonomous && autonomousInitialMessage && !waContext) {
        const initMsg = {
          role: 'ai',
          content: autonomousInitialMessage,
          timestamp: getCurrentTimeInfo(),
          isProactive: true
        }
        // Tampilkan langsung di layar obrolan
        setChatData((prev) => [...prev, initMsg])
        
        // Simpan ke memori sesi agar AI sadar dia baru saja mengucapkan ini
        // WAJIB ditaruh SEBELUM 'userMessage' (elemen terakhir) agar API tidak menolak request karena berakhiran 'assistant'
        chatSession.splice(chatSession.length - 1, 0, {
          role: 'assistant',
          content: autonomousInitialMessage
        })
      }

      // ========== STEP 3: AGENTIC LOOP ==========
      const loopMessages = [...chatSession]

      let isDone = false
      let stepCount = 0
      let lastDecision = null
      let allSources = []
      let lastActionTool = null
      let lastActionQuery = null
      let duplicateActionCount = 0
      let lastToolExecution = null
      let executedToolsList = []

      let execSteps = [{ task: 'Menganalisis Konteks...' }] // Initial node for hologram

      while (!isDone) {
        // --- Safety: Cek abort ---
        if (abortControllerRef.current.signal.aborted) break

        // --- Cek Intervensi User ---
        if (interventionBufferRef.current.length > 0) {
          const interventions = interventionBufferRef.current.join('\n')
          loopMessages.push({
            role: 'user',
            content: `[USER INTERVENTION]: ${interventions}`
          })
          interventionBufferRef.current = [] // Kosongkan buffer
          
          setChatData((prev) => {
            const filtered = prev.filter((item) => !item.isThinking)
            return [...filtered, { role: 'user', content: interventions }]
          })
          
          execSteps.push({ task: `Intervensi User: ${interventions}` })
          pushProcess({
            id: agenticProcessId,
            type: 'planning',
            status: 'active',
            data: {
              steps: [...execSteps],
              currentStep: execSteps.length - 1,
              reasoning: 'Menerima arahan baru dari user di tengah proses.'
            }
          })
        }

        stepCount++

        // --- Update UI: Tampilkan step ke berapa ---
        setChatData((prev) => {
          const filtered = prev.filter((item) => !item.isThinking)
          let loadingText = (isAutonomous && autonomousInitialMessage) ? autonomousInitialMessage : 'Bentar, mikir dlu...'
          return [...filtered, { role: 'ai', content: loadingText, isThinking: true }]
        })

        // --- Panggil AI: getNextAction ---
        const decision = await getNextAction(
          userInput,
          loopMessages,
          abortControllerRef.current.signal,
          unifiedContext,
          contextMsgStr,
          activeTopic,
          { ...options, intentQuery: searchQuery, waContext, currentMusicTrack }
        )

        if (options.disableTools) {
          if (decision.action) {
            console.log('[useMarkPlan] disableTools aktif, menghapus action dari decision:', decision.action)
            decision.action = null
          }
          if (!decision.answer) {
            decision.answer = 'Halo! Aku sudah aktif dan siap membantumu. Ada yang bisa kita kerjakan hari ini?'
          }
        }

        lastDecision = decision

        // --- Update active_topic jika ada ---
        if (decision.active_topic) {
          setActiveTopic(decision.active_topic)
        }

        // --- Handle memory jika ada ---
        if (decision.memory) {
          const memoryData = { ...decision.memory }
          memoryData.memory = memoryData.memory
            .trim()
            .replace(/^[\\\"]+|[\\\"]+$/g, '')
            .replace(/\\n/g, '\n')
          // Hapus prefix timestamp lama jika ada biar gak double pas update
          memoryData.memory = memoryData.memory.replace(/^\[.*?\]\s*/, '')
          const dateStr = getCurrentTimeInfo()
          memoryData.memory = `[${dateStr}] ${memoryData.memory}`

          // AUTO-DEDUP GUARD: Jika AI mencoba insert "profile" atau "preference", cek similarity dengan memory existing di Orama
          if (
            memoryData.action === 'insert' &&
            (memoryData.type === 'profile' || memoryData.type === 'preference')
          ) {
            try {
              const newVec = await generateVector(memoryData.memory)
              if (newVec) {
                const similarMemories = await searchMemoriesInOrama(
                  memoryData.memory,
                  newVec,
                  1,
                  memoryData.type
                )
                if (similarMemories.length > 0 && similarMemories[0].score > 0.82) {
                  const bestMatchId = similarMemories[0].id
                  console.log(
                    `🔄 [Orama Auto-Dedup] Mengalihkan insert -> update pada memori ID ${bestMatchId} (similarity: ${similarMemories[0].score.toFixed(2)})`
                  )
                  memoryData.action = 'update'
                  memoryData.id = bestMatchId
                }
              }
            } catch (err) {
              console.error('Error in Orama auto-dedup check:', err)
            }
          }

          const actions = { insert: insertMemory, update: updateMemory, delete: deleteMemory }
          if (actions[memoryData.action]) {
            await actions[memoryData.action](memoryData)
          }
        }

        // ========== CEK KEPUTUSAN AI ==========

        // --- OPSI A: AI mau JAWAB (answer ada, action null) → SELESAI ---
        if (decision.answer && !decision.action) {
          isDone = true

          // Autonomous answers akan langsung di-output-kan sebagai pesan proaktif.
          // Override autonomousInitialMessage dihapus agar LLM bisa bicara hasilnya.

          execSteps.push({ task: 'Selesai' })
          if (execSteps.length > 2) {
            pushProcess({
              id: agenticProcessId,
              type: 'planning',
              status: 'done',
              data: {
                steps: [...execSteps],
                currentStep: execSteps.length,
                reasoning: decision.thought || 'Selesai'
              }
            })
          }

          // TTS
          if (finalIsSpeak && decision.answer) {
            setChatData((prev) => [
              ...prev.filter((item) => !item.isThinking),
              { role: 'ai', content: 'Bentar...', isThinking: true }
            ])
            await playVoice(decision.answer)
          }

          // Notification
          if (window.api.showNotification && !document.hasFocus() && decision.answer) {
            window.api.showNotification('Mark', decision.answer)
          }

          // Tampilkan jawaban akhir di UI
          setChatData((prev) => {
            const filtered = prev.filter((item) => {
              if (item.isThinking) return false;
              // Hapus pesan inisial yang berdiri sendiri agar tidak ganda di riwayat obrolan
              if (isAutonomous && item.isProactive && item.content === autonomousInitialMessage) return false;
              return true;
            })
            
            let finalContent = decision.answer
            if (isAutonomous && autonomousInitialMessage) {
              finalContent = `**${autonomousInitialMessage}**\n\n${decision.answer}`
            }

            const aiMsg = {
              role: 'ai',
              content: finalContent,
              executedTools: executedToolsList.length > 0 ? executedToolsList : null,
              reasoning: decision.thought,
              mood: decision.mood || 'neutral',
              isMemorySaved: decision.memory?.action === 'insert',
              isMemoryUpdated: decision.memory?.action === 'update',
              isMemoryDeleted: decision.memory?.action === 'delete',
              pluginExecution: lastToolExecution,
              isProactive: isAutonomous,
              timestamp: getCurrentTimeInfo(),
              created_at: Date.now()
            }
            if (allSources.length > 0) {
              const uniqueSources = []
              const seenLinks = new Set()
              allSources.forEach((source) => {
                const id = source.link || JSON.stringify(source)
                if (!seenLinks.has(id)) {
                  seenLinks.add(id)
                  uniqueSources.push(source)
                }
              })
              aiMsg.sources = uniqueSources
            }
            return [...filtered, aiMsg]
          })

          // Opsi: Jika loop berakhir, lepas kunci browser
          if (window.api && window.api.browserAction) {
            window.api.browserAction({ action: 'finish' }).catch(() => {})
          }
          break // EXIT LOOP
        }

        // --- OPSI B: AI mau EKSEKUSI TOOL (action ada) → LANJUT LOOP ---
        if (decision.action && decision.action.tool) {
          const tool = decision.action.tool
          const query = decision.action.query || ''

          lastActionTool = tool
          lastActionQuery = query

          // Add to hologram plan
          execSteps.push({ task: `Eksekusi ${tool}`, query: query })
          pushProcess({
            id: agenticProcessId,
            type: 'planning',
            status: 'active',
            data: {
              steps: [...execSteps],
              currentStep: execSteps.length - 1,
              reasoning: decision.thought || `Menjalankan ${tool}`
            }
          })

          // Update UI
          setChatData((prev) => {
            const filtered = prev.filter((item) => !item.isThinking)
            let loadingText = (isAutonomous && autonomousInitialMessage) ? autonomousInitialMessage : 'Bentar, mikir dlu...'
            return [...filtered, { role: 'ai', content: loadingText, isThinking: true }]
          })

          // ========== EXECUTE TOOL ==========
          let resultString = 'Tidak ada hasil.'

          try {
            if (tool === 'yt-search') {
              // --- YOUTUBE SEARCH ---
              const ytResults = await window.api.searchYoutube(query)
              resultString = JSON.stringify(ytResults)
            } else if (tool === 'yt-summary') {
              // --- YOUTUBE SUMMARY ---
              setChatData((prev) => [
                ...prev,
                {
                  role: 'ai',
                  content: 'Menonton video youtube...',
                  isSummarizing: true,
                  youtubeLink: query
                }
              ])
              const yData = await getYoutubeData(query)
              resultString = await getYoutubeSummary(
                query,
                yData,
                abortControllerRef.current.signal
              )
              setChatData((prev) => prev.filter((item) => !item.isSummarizing))
            } else if (tool.startsWith('music')) {
              // --- MUSIC ---
              resultString = await handleMusic(tool, query)
            } else if (tool === 'wa-send') {
              // --- WHATSAPP SEND ---
              const [targetJid, targetText] = (query || '').split('|')
              if (targetJid && targetText) {
                const res = await window.api.sendWaMessage(targetJid.trim(), targetText.trim())
                resultString = res?.success
                  ? `Berhasil mengirim pesan WhatsApp ke ${targetJid}`
                  : `Gagal: ${res?.error || 'Unknown'}`
              } else {
                resultString = `Gagal: format query salah (harus "JID|pesan"): ${query}`
              }
            } else if (tool === 'memory-search') {
              // --- MEMORY SEARCH ---
              const results = await searchExtendedMemory(query)
              const formatted = results.length > 0
                ? results.map(m => `- [${m.type.toUpperCase()}] (ID:${m.id}, Score:${m.score.toFixed(2)}) ${m.memory}`).join('\n')
                : 'Tidak ditemukan memori yang relevan.'
              resultString = `[MEMORY SEARCH RESULTS]\n${formatted}`
            } else if (tool === 'speak') {
              // --- NATIVE TTS SPEAKER ---
              if (query && query.trim() !== '') {
                // Jangan pake wait karena kita mau chatnya tetap responsif, tapi kalau await dia nunggu selesai ngomong
                // Tampilkan pesan animasi "Berbicara..."
                setChatData((prev) => {
                  const filtered = prev.filter((item) => !item.isThinking)
                  return [
                    ...filtered,
                    { role: 'ai', content: `(Sedang berbicara) ${query}`, isThinking: true }
                  ]
                })
                await playVoice(query)
                resultString = `Berhasil berbicara secara lisan: "${query}"`
              } else {
                resultString = 'Gagal: teks yang mau diucapkan kosong.'
              }
            } else if (tool === 'screenshot-to-wa') {
              if (waContext) {
                window.api.waTakeScreenshot(waContext.jid, waContext.msgId)
                resultString = 'Screenshot berhasil diambil dan dikirimkan ke WhatsApp user.'
              } else {
                resultString =
                  'Tool screenshot-to-wa HANYA tersedia jika user sedang chat dari WhatsApp.'
              }
            } else if (tool === 'analyze-screen') {
              // --- SCREENSHOT FOR VISION ---
              try {
                const screens = await window.api.takeScreenshot()
                if (screens && screens.length > 0) {
                  setChatData((prev) => {
                    const filtered = prev.filter((item) => !item.isThinking)
                    return [
                      ...filtered,
                      { role: 'ai', content: 'Memproses Vision AI...', isThinking: true }
                    ]
                  })

                  const contentArray = [
                    {
                      type: 'text',
                      text: query || 'Jelaskan dengan detail apa yang terlihat di layar ini.'
                    }
                  ]

                  // Masukkan semua layar (multi-monitor) ke dalam request Vision
                  screens.forEach((screen) => {
                    contentArray.push({
                      type: 'image_url',
                      image_url: { url: screen.data } // Standar mutlak OpenAI API
                    })
                  })

                  const visionResponse = await fetchAI(
                    [{ role: 'user', content: contentArray }],
                    abortControllerRef.current?.signal,
                    false
                  )
                  const textContent =
                    typeof visionResponse === 'object' && visionResponse.content
                      ? visionResponse.content
                      : String(visionResponse)
                  // sk-nry-iKHsWVIcArhPtt1vprUboIV7FZGMO_c9x6izmLfPpUo
                  //
                  // [LOG FETCH] Permintaan user untuk nge-log hasil Vision AI
                  console.log(`[Vision AI - analyze-screen] Hasil analisis:`, textContent)
                  
                  resultString = `Hasil Analisis Layar:\n${textContent}`
                } else {
                  resultString = 'Gagal mengambil screenshot dari sistem operasi.'
                }
              } catch (e) {
                resultString = `Gagal memproses visual: Model AI saat ini mungkin tidak mendukung Vision (Image Analysis) atau terjadi error. Pesan: ${e.message}`
              }
            } else if (tool === 'camera-look') {
              // --- CAMERA VISION ---
              console.log('[camera-look] Tool dipanggil. config[0]?.cameraEnabled:', config[0]?.cameraEnabled, 'requestCameraCapture:', !!requestCameraCapture)
              try {
                if (config[0]?.cameraEnabled === false) {
                  resultString = 'Fitur kamera dimatikan di pengaturan. Beri tahu user untuk mengaktifkannya.'
                } else if (!requestCameraCapture) {
                  resultString = 'Internal Error: Callback requestCameraCapture tidak tersedia.'
                } else {
                  setChatData((prev) => {
                    const filtered = prev.filter((item) => !item.isThinking)
                    return [
                      ...filtered,
                      { role: 'ai', content: 'Mengakses kamera...', isThinking: true }
                    ]
                  })

                  console.log('[camera-look] Memanggil requestCameraCapture...')
                  const cameraFrame = await requestCameraCapture({
                    isAutonomous: isAutonomous,
                    deviceId: config[0]?.cameraDeviceId !== 'default' ? config[0]?.cameraDeviceId : null
                  })
                  console.log('[camera-look] Hasil cameraFrame:', cameraFrame ? `${Math.round(cameraFrame.length / 1024)}KB` : 'null')

                  if (cameraFrame) {
                    setChatData((prev) => {
                      const filtered = prev.filter((item) => !item.isThinking)
                      return [
                        ...filtered,
                        { role: 'ai', content: 'Menganalisis hasil kamera...', isThinking: true }
                      ]
                    })

                    const contentArray = [
                      {
                        type: 'text',
                        text: query || 'Jelaskan dengan detail apa yang terlihat dari kamera ini.'
                      },
                      {
                        type: 'image_url',
                        image_url: { url: cameraFrame }
                      }
                    ]

                    const visionResponse = await fetchAI(
                      [{ role: 'user', content: contentArray }],
                      abortControllerRef.current?.signal,
                      false
                    )

                    const textContent =
                      typeof visionResponse === 'object' && visionResponse.content
                        ? visionResponse.content
                        : String(visionResponse)

                    console.log(`[Vision AI - camera-look] Hasil analisis:`, textContent)
                    resultString = `Hasil Analisis Kamera:\n${textContent}`
                  } else {
                    resultString = 'Gagal mengambil gambar dari kamera. Pastikan kamera terhubung dan tidak sedang digunakan aplikasi lain.'
                  }
                }
              } catch (e) {
                resultString = `Gagal memproses kamera: ${e.message}`
              }
            } else if (
              [
                'file-outline',
                'read-document',
                'read-file',
                'write-file',
                'replace-lines',
                'delete-file',
                'list-dir',
                'grep-search',
                'run-powershell',
                'browser-navigate',
                'browser-read',
                'browser-click',
                'browser-type',
                'browser-scroll',
                'browser-ask-user',
                'browser-close',
                'os-read',
                'os-click',
                'os-type',
                'os-key',
                'os-scroll',
                'os-open',
                'os-list-windows',
                'os-focus-window',
                'os-ask',
                'os-control-open',
                'os-control-close'
              ].includes(tool)
            ) {
              // --- NATIVE TOOLS (Built-in) ---
              const approvalCheck = await window.api.checkToolApproval(tool, query)

              if (approvalCheck.needsApproval && requestApproval) {
                const userApproved = await requestApproval(approvalCheck.message, tool, query)
                if (!userApproved) {
                  resultString = `[DITOLAK] User menolak eksekusi "${tool}". Cari cara lain atau tanyakan user.`
                  loopMessages.push(
                    {
                      role: 'assistant',
                      content: JSON.stringify({
                        thought: decision.thought,
                        action: decision.action
                      })
                    },
                    {
                      role: 'user',
                      content: `[OBSERVATION] Hasil eksekusi tool "${tool}": ${resultString}`
                    }
                  )
                  continue
                }
              }

              const nativePromise = window.api.executeNativeTool(tool, query)
              const abortPromise = new Promise((_, reject) => {
                const onAbort = () => reject(new Error('AbortError'))
                if (abortControllerRef.current.signal.aborted) return onAbort()
                abortControllerRef.current.signal.addEventListener('abort', onAbort)
              })

              const res = await Promise.race([nativePromise, abortPromise])
              if (res.success) {
                resultString = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)

                // --- ON-THE-FLY ORAMA HYBRID VECTOR SEARCH UNTUK READ-DOCUMENT ---
                if (tool === 'read-document') {
                  const parts = query.split('||')
                  const searchQuery = parts[1] ? parts[1].trim() : ''
                  let fullText = ''
                  if (typeof res.data === 'object' && res.data !== null) {
                    fullText = res.data.content || ''
                  } else if (typeof res.data === 'string') {
                    fullText = res.data
                  }

                  if (searchQuery && fullText) {
                    try {
                      const oramaHits = await searchDocumentWithOrama(fullText, searchQuery, 5)
                      if (oramaHits && oramaHits.length > 0) {
                        const formattedHits = oramaHits
                          .map((h, i) => `[Orama Vector Match #${i + 1} (Score: ${h.score.toFixed(2)})]\n${h.content}`)
                          .join('\n\n---\n\n')
                        resultString = `[PENCARIAN SEMANTIK ORAMA VECTOR UNTUK "${searchQuery}"]:\n${formattedHits}`
                      }
                    } catch (oramaErr) {
                      console.error('[useMarkPlan] Gagal Orama search untuk read-document:', oramaErr)
                    }
                  } else if (fullText && fullText.length > 2500) {
                    resultString = `${fullText.slice(0, 2500)}\n\n[DOKUMEN DIPOTONG (Total: ${fullText.length} karakter). Jika ingin mencari bagian/topik spesifik di dokumen ini, panggil read-document dengan query: "${parts[0]}||kata_kunci"]`
                  }
                }
              } else {
                resultString = `[ERROR] ${tool} gagal: ${res.error}`
              }

              lastToolExecution = { action: tool, query, result: resultString }
            } else {
              // --- PLUGIN FALLBACK ---
              const pluginProcessId = `plugin-${Date.now()}`
              pushProcess({
                id: pluginProcessId,
                type: 'plugin-execution',
                status: 'active',
                data: { action: tool, query }
              })

              const pluginPromise = window.api.executePlugin(tool, query)
              const abortPromise = new Promise((_, reject) => {
                const onAbort = () => reject(new Error('AbortError'))
                if (abortControllerRef.current.signal.aborted) return onAbort()
                abortControllerRef.current.signal.addEventListener('abort', onAbort)
              })
              const res = await Promise.race([pluginPromise, abortPromise])
              if (res.success) {
                resultString = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
              } else {
                resultString = `[ERROR] Plugin ${tool} gagal: ${res.error}`
              }

              lastToolExecution = { action: tool, query, result: resultString }
              pushProcess({
                id: pluginProcessId,
                type: 'plugin-execution',
                status: 'done',
                data: { action: tool, query, result: resultString }
              })
            }
          } catch (toolError) {
            if (toolError.name === 'AbortError' || toolError.message.includes('AbortError')) {
              throw toolError
            }
            resultString = `[ERROR] Tool ${tool} crash: ${toolError.message}`
          }

          executedToolsList.push({
            tool: tool,
            query: query,
            resultSummary:
              typeof resultString === 'string' && resultString.length > 250
                ? resultString.slice(0, 250) + '...'
                : resultString
          })

          // --- FEED OBSERVATION BACK KE AI ---
          let obsStr = resultString
          if (typeof resultString === 'string' && resultString.length > 3000) {
            obsStr = `${resultString.slice(0, 3000)}\n\n[SISA OUTPUT DIPOTONG (Total: ${resultString.length} karakter). Gunakan startLine||endLine atau grep-search untuk mencari bagian spesifik.]`
          }

          loopMessages.push(
            {
              role: 'assistant',
              content: JSON.stringify({ thought: decision.thought, action: decision.action })
            },
            {
              role: 'user',
              content: `[OBSERVATION] Hasil eksekusi tool "${tool}": ${obsStr}`
            }
          )

          continue
        }

        // --- FALLBACK: Jika AI tidak mengisi action maupun answer ---
        console.warn('[useMarkPlan] AI returned neither action nor answer. Forcing done.')
        isDone = true
        setChatData((prev) => [
          ...prev.filter((item) => !item.isThinking),
          {
            role: 'ai',
            content: 'Maaf terjadi kesalahan di proses berpikir.',
            mood: 'neutral',
            timestamp: getCurrentTimeInfo()
          }
        ])
      }

      // ========== CLEANUP ==========
      if (!lastDecision?.answer) {
        if (execSteps.length > 2) {
          pushProcess({
            id: agenticProcessId,
            type: 'planning',
            status: 'done',
            data: {
              steps: [...execSteps],
              currentStep: execSteps.length,
              reasoning: 'Loop Selesai'
            }
          })
        }
      }

      if (!waContext && !isAutonomous) {
        setIsLoading(false)
        lastUserPromptRef.current = '' // Sukses, bersihkan simpanan prompt
      }
      setIsAgentBusy(false)
      
      // Cleanup PC session if it was left open
      try {
        if (window.api && window.api.executeNativeTool) {
          window.api.executeNativeTool('os-control-close').catch(() => {})
        }
      } catch (e) {}

    } catch (error) {
      if (error.name !== 'AbortError' && !error.message.includes('AbortError')) {
        console.error('Planning Error:', error)
      }

      if (!waContext && !isAutonomous) {
        setIsLoading(false)
        if (!isSystem && lastUserPromptRef.current) {
          setMessage(lastUserPromptRef.current) // Kembalikan prompt sebelumnya yang gagal/di-abort ke input bar
          lastUserPromptRef.current = ''
        }
      }
      setIsAgentBusy(false)

      // Emergency cleanup PC session
      try {
        if (window.api && window.api.executeNativeTool) {
          window.api.executeNativeTool('os-control-close').catch(() => {})
        }
      } catch (e) {}

      dismissProcess(agenticProcessId)

      if (error.name === 'AbortError' || error.message.includes('AbortError')) {
        setChatData((prev) => [
          ...prev.filter((item) => !item.isThinking && !item.isSearching),
          {
            role: 'ai',
            content: 'Oke, proses gue batalin ya bro.',
            reasoning: 'Proses dibatalkan secara paksa.',
            mood: 'neutral',
            timestamp: new Date().toLocaleTimeString('id-ID', {
              hour: '2-digit',
              minute: '2-digit'
            })
          }
        ])
      } else {
        if (isSystem && !isAutonomous) {
          const fallbackGreetings = [
            "Sistem aktif. Halo, saya Mark. Ada yang bisa saya bantu hari ini?",
            "Mark sudah online. Silakan berikan perintah.",
            "Halo bro! Sistem berhasil diinisialisasi. Ada yang perlu saya kerjakan?",
            "Sistem Mark siap digunakan. Ada tugas untukku hari ini?",
            "Halo! Saya siap membantumu."
          ]
          const randomGreeting = fallbackGreetings[Math.floor(Math.random() * fallbackGreetings.length)]
          
          setChatData((prev) => [
            ...prev.filter((item) => !item.isThinking && !item.isSearching),
            { 
              role: 'ai', 
              content: randomGreeting,
              timestamp: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
            }
          ])
        } else if (isAutonomous) {
          // Gagal diam-diam (silent fail) kalau autonomous error (misal AI gagal ngeluarin format JSON)
          setChatData((prev) => prev.filter((item) => !item.isThinking && !item.isSearching && !item.isProactive))
        } else {
          setChatData((prev) => [
            ...prev.filter((item) => !item.isThinking && !item.isSearching),
            { role: 'ai', content: `Maaf, terjadi kesalahan: ${error.message}` }
          ])
        }
      }
    } finally {
      if (!waContext) {
        isExecutingRef.current = false
      }
    }
  }
  return { handlePlanningCommand, handleIntervention }
}
