const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { spawn } = require('node:child_process')

const isDev = process.env.GCAM_STUDIO_DEV === '1'
const DEV_WEB = 'http://127.0.0.1:5173'
const DEV_API = 'http://127.0.0.1:8765'

let mainWindow = null
let backend = null
let studioDataDir = ''

function waitFor(url, timeoutMs = 60000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode === 200) resolve(true)
        else if (Date.now() - start > timeoutMs) reject(new Error(`服务未就绪：${url} (${res.statusCode})`))
        else setTimeout(tick, 400)
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`等待服务超时：${url}`))
        else setTimeout(tick, 400)
      })
      req.setTimeout(2000, () => req.destroy())
    }
    tick()
  })
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function backendLogPath() {
  return path.join(app.getPath('userData'), 'backend.log')
}

async function startBackend() {
  if (isDev) return DEV_API
  const port = await getFreePort()
  const exe = path.join(process.resourcesPath, 'backend', 'gcam-studio-backend.exe')
  if (!fs.existsSync(exe)) {
    throw new Error(`找不到后端程序：${exe}`)
  }
  const webDir = path.join(process.resourcesPath, 'web')
  // Running the unpacked exe from this source tree should keep using the
  // project data. An installed or copied copy falls back to the user profile.
  // resources/backend/exe -> win-unpacked -> release -> GCAM-Studio/data
  const besideSource = path.resolve(path.dirname(exe), '..', '..', '..', '..', 'data')
  const dataDir = process.env.GCAM_STUDIO_DATA_DIR || (fs.existsSync(path.join(besideSource, 'settings.json'))
    ? besideSource
    : path.join(app.getPath('userData'), 'data'))
  fs.mkdirSync(dataDir, { recursive: true })
  studioDataDir = dataDir
  const logPath = backendLogPath()
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  // Windows Node cannot inherit a numeric file descriptor from fs.openSync.
  // Passing one to spawn throws "spawn UNKNOWN" before the backend starts.
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })
  backend = spawn(exe, ['--port', String(port)], {
    env: {
      ...process.env,
      GCAM_STUDIO_HOME: path.join(process.resourcesPath),
      GCAM_STUDIO_DATA_DIR: dataDir,
      GCAM_STUDIO_WEB_DIR: webDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  backend.stdout.on('data', (chunk) => logStream.write(chunk))
  backend.stderr.on('data', (chunk) => logStream.write(chunk))
  backend.on('error', (err) => logStream.write(`后端启动失败：${err.message}\n`))
  backend.on('exit', (code) => {
    logStream.end()
    if (code !== 0 && mainWindow) {
      dialog.showErrorBox('后端已退出', `GCAM-China Studio 后端进程退出，代码 ${code}。\n日志：${logPath}`)
    }
  })
  try {
    await waitFor(`http://127.0.0.1:${port}/api/health`)
  } catch (err) {
    let tail = ''
    try { tail = fs.readFileSync(logPath, 'utf8').slice(-1500) } catch {}
    throw new Error(`${err.message}\n日志：${logPath}\n${tail}`.trim())
  }
  return `http://127.0.0.1:${port}`
}

async function createWindow() {
  const base = await startBackend()
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#f5f7fa',
    title: 'GCAM-China Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const url = isDev ? DEV_WEB : base
  await mainWindow.loadURL(url)
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
  mainWindow.on('closed', () => { mainWindow = null })
}

const template = [
  {
    label: '文件',
    submenu: [
      { label: '打开 Studio 数据目录', click: () => shell.openPath(studioDataDir || app.getPath('userData')) },
      { type: 'separator' },
      { role: 'quit', label: '退出' },
    ],
  },
  { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
  { label: '视图', submenu: [{ role: 'reload', label: '刷新' }, { role: 'toggleDevTools', label: '开发者工具' }, { type: 'separator' }, { role: 'resetZoom', label: '重置缩放' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
  { label: '帮助', submenu: [{ label: 'GCAM-China 文档', click: () => shell.openExternal('https://umd-cgs.github.io/metarepo_gcam-china/index.html') }, { label: '关于', click: () => dialog.showMessageBox({ message: `GCAM-China Studio ${app.getVersion()}`, detail: 'GCAM-China v8 情景与数据工作台' }) }] },
]

ipcMain.handle('studio:selectFolder', async (_event, defaultPath) => {
  const r = await dialog.showOpenDialog({
    title: '选择文件夹',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
  })
  return r.canceled ? '' : r.filePaths[0]
})
ipcMain.handle('studio:selectFile', async (_event, options = {}) => {
  const filters = Array.isArray(options.filters) && options.filters.length
    ? options.filters
    : [{ name: '可执行文件', extensions: ['exe'] }]
  const r = await dialog.showOpenDialog({
    title: options.title || '选择文件',
    properties: ['openFile'],
    defaultPath: typeof options.defaultPath === 'string' && options.defaultPath ? options.defaultPath : undefined,
    filters,
  })
  return r.canceled ? '' : r.filePaths[0]
})
ipcMain.handle('studio:openPath', async (_e, p) => shell.openPath(p))
ipcMain.handle('studio:version', () => app.getVersion())

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
})

app.whenReady().then(async () => {
  if (!singleInstance) return
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  try {
    await createWindow()
  } catch (err) {
    dialog.showErrorBox('GCAM-China Studio 无法启动', String(err && err.stack ? err.stack : err))
    app.quit()
    return
  }
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        await createWindow()
      } catch (err) {
        dialog.showErrorBox('GCAM-China Studio 无法启动', String(err && err.stack ? err.stack : err))
      }
    }
  })
})

app.on('window-all-closed', () => {
  if (backend) {
    try {
      if (process.platform === 'win32') {
        require('node:child_process').spawnSync('taskkill', ['/T', '/F', '/PID', String(backend.pid)], { windowsHide: true })
      } else backend.kill()
    } catch {}
  }
  if (process.platform !== 'darwin') app.quit()
})
