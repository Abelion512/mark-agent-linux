// src/main/pc-agent.js
// MARK PC Automation Engine - Zero Vision Cost Desktop Controller
// Uses native Windows UIAutomation, local WinRT OCR fallback, and Win32 action script

import { spawn } from 'child_process'
import { join } from 'path'
import { app, BrowserWindow, globalShortcut, screen } from 'electron'
import fs from 'fs'

let lastReadResult = null
let overlayWindow = null
let activeChildProcess = null
let isStoppedByUser = false
let lastStopReason = null
let overlayHideTimeout = null
let pendingAskResolve = null

function getOverlayHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: transparent;
      overflow: hidden;
      user-select: none;
    }
    .banner {
      width: 100%;
      height: 86px;
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(16px);
      border: 1.5px solid rgba(31, 184, 84, 0.45);
      border-radius: 18px;
      box-shadow: 0 10px 30px -5px rgba(0, 0, 0, 0.65);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      color: #f8fafc;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .left { display: flex; align-items: center; gap: 14px; }
    .pulse-dot {
      width: 12px; height: 12px; background: #22c55e; border-radius: 50%;
      box-shadow: 0 0 12px #22c55e; animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }
    .title { font-size: 14px; font-weight: 700; letter-spacing: 0.5px; color: #f8fafc; }
    .subtitle { font-size: 11px; color: #94a3b8; margin-top: 3px; }
    .btn-stop {
      background: rgba(239, 68, 68, 0.15); color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.4); padding: 9px 16px;
      border-radius: 10px; font-weight: 600; font-size: 12px;
      cursor: pointer; display: flex; align-items: center; gap: 6px;
      transition: all 0.2s;
    }
    .btn-stop:hover { background: #ef4444; color: white; box-shadow: 0 0 15px rgba(239, 68, 68, 0.4); }
    .modal-content {
      display: none; width: 100%; height: 100%;
      background: rgba(15, 23, 42, 0.98); backdrop-filter: blur(20px);
      border: 1.5px solid rgba(239, 68, 68, 0.5); border-radius: 18px;
      padding: 20px; flex-direction: column; justify-content: space-between;
    }
    .modal-title { font-size: 15px; font-weight: 700; color: #ef4444; display: flex; align-items: center; gap: 8px; }
    .modal-subtitle { font-size: 12px; color: #94a3b8; margin: 8px 0 12px 0; }
    input[type="text"] {
      width: 100%; padding: 10px 14px; background: rgba(30, 41, 59, 0.7);
      border: 1px solid #475569; border-radius: 10px; color: white;
      font-size: 13px; outline: none; transition: all 0.2s;
    }
    input[type="text"]:focus { border-color: #ef4444; box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2); }
    .btn-send {
      width: 100%; padding: 11px; background: #ef4444; color: white;
      border: none; border-radius: 10px; font-weight: 700; font-size: 13px;
      cursor: pointer; margin-top: 14px; transition: all 0.2s;
    }
    .btn-send:hover { background: #dc2626; }
  </style>
</head>
<body>
  <div class="banner" id="banner">
    <div class="left">
      <div class="pulse-dot"></div>
      <div>
        <div class="title">MARK PC AUTOMATION</div>
        <div class="subtitle">Press <strong style="color: #cbd5e1;">[Ctrl+S]</strong> or click Stop to halt automation</div>
      </div>
    </div>
    <button class="btn-stop" id="btn-stop" onclick="onStop()">
      ⏹ Stop (Ctrl+S)
    </button>
  </div>

  <div class="modal-content" id="modal">
    <div>
      <div class="modal-title">⏸️ Automation Paused by User</div>
      <div class="modal-subtitle">Why did you stop automation? Give MARK instructions or correction:</div>
      <input type="text" id="reason-input" placeholder="e.g., Tolong buka window Notepad dulu brok..." autofocus />
    </div>
    <button class="btn-send" id="btn-send" onclick="onSend()">
      Send to MARK AI
    </button>
  </div>

  <script>
    function onStop() {
      document.title = 'MARK_PC_STOP_CLICKED:' + Date.now();
    }
    function showAskModal(titleText, subtitleText, btnColor) {
      document.getElementById('banner').style.display = 'none';
      const modal = document.getElementById('modal');
      modal.style.display = 'flex';
      if (titleText) modal.querySelector('.modal-title').innerText = titleText;
      if (subtitleText) modal.querySelector('.modal-subtitle').innerText = subtitleText;
      if (btnColor) {
        modal.style.borderColor = btnColor;
        const btn = document.getElementById('btn-send');
        btn.style.background = btnColor;
        btn.innerText = 'Resume Automation';
      }
      const input = document.getElementById('reason-input');
      input.focus();
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') onSend();
      });
    }
    function onSend() {
      const val = document.getElementById('reason-input').value;
      document.title = 'MARK_PC_STOP_REASON:' + (val.trim() || 'User stopped PC automation without comment.');
    }
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        onStop();
      }
    });
  </script>
</body>
</html>`
}

function showPCOverlay() {
  if (overlayHideTimeout) {
    clearTimeout(overlayHideTimeout)
    overlayHideTimeout = null
  }
  if (isStoppedByUser || pendingAskResolve) return

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show()
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    return
  }

  try {
    const display = screen.getPrimaryDisplay()
    const { width } = display.workAreaSize
    const winWidth = 460
    const winHeight = 90
    overlayWindow = new BrowserWindow({
      width: winWidth,
      height: winHeight,
      x: Math.floor((width - winWidth) / 2),
      y: 20,
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getOverlayHTML())}`)

    overlayWindow.on('page-title-updated', (event, title) => {
      if (title.startsWith('MARK_PC_STOP_CLICKED:')) {
        triggerEmergencyStop()
      } else if (title.startsWith('MARK_PC_STOP_REASON:')) {
        const reason = title.replace('MARK_PC_STOP_REASON:', '').trim()
        lastStopReason = reason
        if (pendingAskResolve) {
          const resolveFn = pendingAskResolve
          pendingAskResolve = null
          resolveFn(reason)
        }
        hidePCOverlay()
      }
    })

    try {
      globalShortcut.unregister('CommandOrControl+S')
      globalShortcut.register('CommandOrControl+S', () => {
        triggerEmergencyStop()
      })
    } catch (err) {
      console.warn('[PC-Agent] Could not register Ctrl+S global shortcut:', err.message)
    }
  } catch (err) {
    console.warn('[PC-Agent] Could not create overlay window:', err.message)
  }
}

function hidePCOverlay() {
  if (overlayHideTimeout) {
    clearTimeout(overlayHideTimeout)
    overlayHideTimeout = null
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.close()
    } catch (err) {}
  }
  overlayWindow = null
  try {
    globalShortcut.unregister('CommandOrControl+S')
  } catch (err) {}
}

function scheduleHidePCOverlay() {
  if (overlayHideTimeout) {
    clearTimeout(overlayHideTimeout)
  }
  overlayHideTimeout = setTimeout(() => {
    if (!isStoppedByUser && !pendingAskResolve) {
      hidePCOverlay()
    }
  }, 1800)
}

function triggerEmergencyStop() {
  if (activeChildProcess) {
    try {
      activeChildProcess.kill()
    } catch (err) {}
    activeChildProcess = null
  }
  isStoppedByUser = true

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.setSize(440, 240)
      overlayWindow.webContents.executeJavaScript(`showAskModal()`)
    } catch (err) {}
  }
}

/**
 * Ask user via PC automation overlay modal
 */
export async function askUserPC(query = '') {
  isStoppedByUser = false
  showPCOverlay()
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.setSize(440, 240)
      const cleanMsg = query.replace(/'/g, "\\'").replace(/"/g, '\\"')
      overlayWindow.webContents.executeJavaScript(
        `showAskModal("❓ MARK Needs Your Help", "${cleanMsg}", "#3b82f6")`
      )
    } catch (err) {}
  }
  const comment = await new Promise((resolve) => {
    pendingAskResolve = (val) => resolve(val)
  })
  return JSON.stringify({
    status: 'success',
    user_response: comment
  })
}

/**
 * Run a PowerShell script from pc-agent-scripts
 */
function runScript(scriptName, args = []) {
  return new Promise((resolve) => {
    let scriptPath = join(__dirname, '../../src/main/pc-agent-scripts', scriptName)
    if (app.isPackaged) {
      const unpackedPath = join(
        process.resourcesPath,
        'app.asar.unpacked',
        'src',
        'main',
        'pc-agent-scripts',
        scriptName
      )
      if (fs.existsSync(unpackedPath)) {
        scriptPath = unpackedPath
      } else {
        scriptPath = scriptPath.replace('app.asar', 'app.asar.unpacked')
      }
    } else if (!fs.existsSync(scriptPath)) {
      scriptPath = join(__dirname, 'pc-agent-scripts', scriptName)
    }

    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      ...args
    ])
    activeChildProcess = ps

    let stdout = ''
    let stderr = ''

    ps.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    ps.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    ps.on('close', (code) => {
      if (activeChildProcess === ps) {
        activeChildProcess = null
      }
      if (code !== 0 && stderr) {
        console.warn(`[PC-Agent] Script ${scriptName} exited with code ${code}: ${stderr}`)
      }
      if (isStoppedByUser) {
        resolve(
          JSON.stringify({
            status: 'stopped_by_user',
            message: `PC automation stopped by user: ${lastStopReason || 'User pressed Ctrl+S'}`,
            user_message: lastStopReason || 'User pressed Ctrl+S / Stop button',
            action: 'os-ask'
          })
        )
        return
      }
      resolve(stdout.trim())
    })

    ps.on('error', (err) => {
      if (activeChildProcess === ps) {
        activeChildProcess = null
      }
      console.error(`[PC-Agent] Error spawning script ${scriptName}:`, err)
      resolve('')
    })
  })
}

/**
 * Read the active desktop GUI elements (UIAutomation with OCR fallback)
 */
export async function readDesktop() {
  if (isStoppedByUser) {
    return { window: 'stopped_by_user', method: 'stopped_by_user', elements: [], element_count: 0, message: lastStopReason }
  }
  showPCOverlay()
  try {
    const uiText = await runScript('read-ui.ps1')
    let parsed = null
    if (uiText) {
      try {
        parsed = JSON.parse(uiText)
      } catch (e) {
        console.warn('[PC-Agent] Failed to parse UIAutomation JSON, falling back to OCR')
      }
    }

    // If UIAutomation returned 0 elements or failed, fallback to local OCR
    if (!parsed || !parsed.elements || parsed.elements.length === 0) {
      console.log('[PC-Agent] UIAutomation returned 0 elements. Executing local WinRT OCR fallback...')
      const ocrText = await runScript('ocr-region.ps1')
      if (ocrText) {
        try {
          parsed = JSON.parse(ocrText)
        } catch {}
      }
    }

    if (parsed && parsed.elements) {
      lastReadResult = parsed
    } else {
      parsed = { window: 'unknown', method: 'none', elements: [], element_count: 0 }
    }

    scheduleHidePCOverlay()
    return parsed
  } catch (err) {
    scheduleHidePCOverlay()
    console.error('[PC-Agent] readDesktop error:', err)
    return { window: 'error', method: 'error', elements: [], element_count: 0 }
  }
}

/**
 * Helper: Find coordinates from element ID or x||y string
 */
function resolveCoordinates(query) {
  if (!query) return null

  // If query is "x||y"
  if (query.includes('||')) {
    const parts = query.split('||').map((p) => parseInt(p.trim(), 10))
    if (!isNaN(parts[0]) && !isNaN(parts[1])) {
      return { x: parts[0], y: parts[1] }
    }
  }

  // If query is element ID (number)
  const id = parseInt(query.trim(), 10)
  if (!isNaN(id) && lastReadResult && lastReadResult.elements) {
    const el = lastReadResult.elements.find((item) => item.id === id)
    if (el && el.rect && el.rect.length === 4) {
      const centerX = Math.round(el.rect[0] + el.rect[2] / 2)
      const centerY = Math.round(el.rect[1] + el.rect[3] / 2)
      return { x: centerX, y: centerY }
    }
  }

  return null
}

/**
 * Click an element by ID or coordinates
 */
export async function executeClick(query) {
  if (isStoppedByUser) {
    return `[PC-Agent] Stopped by user: ${lastStopReason || 'User pressed Ctrl+S'}`
  }
  showPCOverlay()
  const coords = resolveCoordinates(query)
  if (!coords) {
    scheduleHidePCOverlay()
    return `[PC-Agent] Error: Element ID or coordinates '${query}' not found. Try os-read first.`
  }
  const result = await runScript('win-action.ps1', [
    '-Action',
    'click',
    '-X',
    coords.x.toString(),
    '-Y',
    coords.y.toString()
  ])
  scheduleHidePCOverlay()
  return `[PC-Agent] Clicked at (${coords.x}, ${coords.y}). ${result}`
}

/**
 * Type text into an element by ID or directly
 */
export async function executeType(query) {
  if (isStoppedByUser) {
    return `[PC-Agent] Stopped by user: ${lastStopReason || 'User pressed Ctrl+S'}`
  }
  showPCOverlay()
  let text = query
  let coords = null

  if (query && query.includes('||')) {
    const idx = query.indexOf('||')
    const possibleId = query.substring(0, idx).trim()
    text = query.substring(idx + 2).trim()
    coords = resolveCoordinates(possibleId)
  }

  // If element ID was provided, click it first to focus
  if (coords) {
    await runScript('win-action.ps1', [
      '-Action',
      'click',
      '-X',
      coords.x.toString(),
      '-Y',
      coords.y.toString()
    ])
  }

  const result = await runScript('win-action.ps1', ['-Action', 'type', '-Text', text])
  scheduleHidePCOverlay()
  return `[PC-Agent] Typed "${text}". ${result}`
}

/**
 * Press a keyboard shortcut combo
 */
export async function executeKey(combo) {
  if (isStoppedByUser) {
    return `[PC-Agent] Stopped by user: ${lastStopReason || 'User pressed Ctrl+S'}`
  }
  showPCOverlay()
  const result = await runScript('win-action.ps1', ['-Action', 'key', '-Combo', combo])
  scheduleHidePCOverlay()
  return `[PC-Agent] Pressed key combo "${combo}". ${result}`
}

/**
 * Scroll mouse wheel
 */
export async function executeScroll(query) {
  if (isStoppedByUser) {
    return `[PC-Agent] Stopped by user: ${lastStopReason || 'User pressed Ctrl+S'}`
  }
  showPCOverlay()
  let direction = 'down'
  let amount = 5
  if (query && query.includes('||')) {
    const parts = query.split('||')
    direction = parts[0].trim().toLowerCase()
    const amt = parseInt(parts[1].trim(), 10)
    if (!isNaN(amt)) amount = amt
  } else if (query) {
    direction = query.trim().toLowerCase()
  }

  const result = await runScript('win-action.ps1', [
    '-Action',
    'scroll',
    '-Direction',
    direction,
    '-Amount',
    amount.toString()
  ])
  scheduleHidePCOverlay()
  return `[PC-Agent] Scrolled ${direction} by ${amount}. ${result}`
}

/**
 * Open an application
 */
export async function openApp(target) {
  if (isStoppedByUser) {
    return `[PC-Agent] Stopped by user: ${lastStopReason || 'User pressed Ctrl+S'}`
  }
  showPCOverlay()
  const result = await runScript('win-action.ps1', ['-Action', 'open', '-Target', target])
  scheduleHidePCOverlay()
  return `[PC-Agent] Opened application "${target}". ${result}`
}

/**
 * List all active top-level windows
 */
export async function listWindows() {
  if (isStoppedByUser) {
    return { status: 'stopped_by_user', windows: [], count: 0, message: lastStopReason }
  }
  showPCOverlay()
  const result = await runScript('win-action.ps1', ['-Action', 'list-windows'])
  scheduleHidePCOverlay()
  try {
    const parsed = JSON.parse(result)
    return { status: 'success', windows: parsed, count: parsed.length }
  } catch {
    return { status: 'error', windows: [], count: 0, raw: result }
  }
}

/**
 * Focus window by title substring
 */
export async function focusWindow(title) {
  if (isStoppedByUser) {
    return `[PC-Agent] Stopped by user: ${lastStopReason || 'User pressed Ctrl+S'}`
  }
  showPCOverlay()
  const result = await runScript('win-action.ps1', ['-Action', 'focus-window', '-Target', title])
  scheduleHidePCOverlay()
  return `[PC-Agent] Focus window "${title}". ${result}`
}
