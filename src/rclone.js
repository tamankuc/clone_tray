'use strict'

const { exec, execSync, spawn } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const ini = require('ini')
const { app } = require('electron')
const isDev = require('electron-is-dev')
const settings = require('./settings')
const dialogs = require('./dialogs')
const fetch = require('node-fetch')

// Constants
const UnsupportedRcloneProviders = [
  'union',
  'crypt'
]

const BucketRequiredProviders = [
  'b2',
  'swift', 
  's3',
  'gsc',
  'hubic'
]
/**
 * API URLs for Rclone operations
 * @private
 */
const ApiUrls = {
  // Core operations
  version: 'core/version',
  stats: 'core/stats',
  bwlimit: 'core/bwlimit',
  memstats: 'core/memstats',
  
  // Config operations
  providers: 'config/providers',
  configDump: 'config/dump',
  configGet: 'config/get',
  configCreate: 'config/create',
  configUpdate: 'config/update',
  configDelete: 'config/delete',
  listRemotes: 'config/listremotes',
  
  // Mount operations
  listMounts: 'mount/listmounts',
  createMount: 'mount/mount',
  removeMount: 'mount/unmount',
  unmountAll: 'mount/unmountall',
  
  // Job operations
  listJobs: 'job/list',
  jobStatus: 'job/status',
  stopJob: 'job/stop',
  
  // File operations
  mkdir: 'operations/mkdir',
  purge: 'operations/purge',
  deleteFile: 'operations/deletefile',
  moveFile: 'operations/movefile',
  copyFile: 'operations/copyfile',
  listFiles: 'operations/list',
  fsinfo: 'operations/fsinfo',
  about: 'operations/about',
  cleanup: 'operations/cleanup',
  
  // Sync operations
  moveDir: 'sync/move',
  copyDir: 'sync/copy',
  
  // Authentication
  noopAuth: 'rc/noopauth',
  
  // Options
  getOptions: 'options/get'
}
const RcloneBinaryName = process.platform === 'win32' ? 'rclone.exe' : 'rclone'

const RcloneBinaryBundled = app.isPackaged
  ? path.join(process.resourcesPath, 'rclone', process.platform, RcloneBinaryName)
  : path.join(app.getAppPath(), 'rclone', process.platform, RcloneBinaryName)

const tempDir = app.getPath('temp')

// Cache object
const Cache = {
  version: null,
  configFile: '',
  providers: {},
  bookmarks: {},
  mountPoints: {},
  downloads: {},
  uploads: {},
  automaticUploads: {},
  servePoints: {},
  apiProcess: null,
  apiEndpoint: null
}

const UpdateCallbacksRegistry = []

// Helper functions
const getRcloneBinary = function() {
  return settings.get('rclone_use_bundled') ? RcloneBinaryBundled : RcloneBinaryName
}

/**
 * Make request to Rclone API with correct URLs
 * @param {string} method 
 * @param {string} endpoint
 * @param {object} params
 * @returns {Promise}
 * @private
 */
const makeRcloneRequest = async function(method, endpoint, params = null) {
  try {
    // Проверяем что API сервер запущен
    if (!Cache.apiProcess || !Cache.apiEndpoint) {
      console.log('API not initialized, falling back to CLI')
      return await executeCliCommand(endpoint, params)
    }

    const url = `${Cache.apiEndpoint}/${endpoint}`
    console.log(`Making API request: ${method} ${url}`, params || '')

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 5000
    }

    if (params) {
      options.body = JSON.stringify(params)
    }

    const response = await fetch(url, options)
    console.log(`API Response status: ${response.status}`)
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error('API Error response:', errorText)
      throw new Error(`HTTP error ${response.status}: ${errorText}`)
    }

    const data = await response.json()
    console.log('API Response data:', data)

    if (data.error) {
      throw new Error(`API Error: ${data.error}`)
    }

    return data
  } catch (error) {
    console.error(`API request failed for ${endpoint}:`, error)
    return await executeCliCommand(endpoint, params)
  }
}


const executeCliCommand = async function(endpoint, params) {
  console.log('Falling back to CLI command for endpoint:', endpoint)
  const rcloneBinary = getRcloneBinary()

  try {
    switch (endpoint) {
      case 'core/version': {
        const version = execSync(`${rcloneBinary} version`).toString()
        return { version: version.split('\n')[0] }
      }

      case 'config/providers': {
        const providers = {}
        const providerOutput = execSync(`${rcloneBinary} config providers`).toString()
        providerOutput.split('\n').forEach(line => {
          const match = line.match(/^\s*(\w+):\s*(.+)$/)
          if (match) {
            providers[match[1]] = match[2]
          }
        })
        return { providers }
      }

      case 'config/dump': {
        if (!fs.existsSync(Cache.configFile)) {
          return {}
        }
        const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
        return config
      }

      case 'config/get': {
        const configPath = path.join(app.getPath('userData'), 'rclone.conf')
        return { path: configPath }
      }

      default:
        console.error(`Unsupported CLI fallback for endpoint: ${endpoint}`)
        throw new Error(`Unsupported CLI fallback for endpoint: ${endpoint}`)
    }
  } catch (error) {
    console.error('CLI execution failed:', error)
    throw error
  }
}

const stopRcloneAPI = async function() {
  if (Cache.apiProcess) {
    Cache.apiProcess.kill()
    Cache.apiProcess = null
    Cache.apiEndpoint = null
  }
}

const executeRcloneCommand = async function(command, options = {}) {
  try {
    const response = await makeRcloneRequest('POST', '/core/command', {
      command: command,
      ...options
    })

    if (response.error) {
      throw new Error(response.error)
    }

    return response
  } catch (error) {
    console.error('Failed to execute rclone command:', error)
    throw error
  }
}

const startRcloneAPI = async function() {
  return new Promise((resolve, reject) => {
    try {
      if (!settings.get('rclone_api_enable')) {
        console.log('Rclone API disabled in settings, using CLI mode')
        resolve(false)
        return
      }

      const port = settings.get('rclone_api_port')
      const rcloneBinary = getRcloneBinary()

      // Ensure rclone exists
      try {
        execSync(`${rcloneBinary} version`)
      } catch (error) {
        console.error('Rclone binary not found:', error)
        resolve(false)
        return
      }

      console.log('Using rclone binary:', rcloneBinary)

      // Set default config path
      const defaultConfigPath = path.join(app.getPath('userData'), 'rclone.conf')
      if (!settings.get('rclone_config')) {
        settings.set('rclone_config', defaultConfigPath)
      }

      // Ensure config directory exists
      const configDir = path.dirname(settings.get('rclone_config'))
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }

      // Touch config file if it doesn't exist
      if (!fs.existsSync(settings.get('rclone_config'))) {
        fs.writeFileSync(settings.get('rclone_config'), '')
      }

      // Build command with all necessary options
      const command = [
        'rcd',
        '--rc-no-auth',
        `--rc-addr=127.0.0.1:${port}`,
        `--config=${settings.get('rclone_config')}`,
        '--rc-allow-origin=*',
        '--rc-enable-metrics',
        '--rc-web-fetch-url=http://127.0.0.1:${port}',
        '--rc-files',
        '--rc-job-expire-duration=24h',
        '--rc-serve',
        '--rc-no-auth',
        '--cache-dir=' + path.join(app.getPath('userData'), 'cache'),
        '--rc-user=user',  // добавляем базовую аутентификацию
        '--rc-pass=pass'
      ]

      if (isDev) {
        command.push('--verbose')
      }

      console.log('Starting Rclone API with command:', rcloneBinary, command.join(' '))

      // Start process detached to prevent it from being killed when parent exits
      const apiProcess = spawn(rcloneBinary, command, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false  // process will be part of parent's process group
      })

      let isStarted = false

      // Функция проверки API
      const checkApi = async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/config/listremotes`)
          if (response.ok) {
            return true
          }
        } catch (error) {
          return false
        }
        return false
      }

      const waitForApi = async () => {
        if (await checkApi()) {
          isStarted = true
          Cache.apiProcess = apiProcess
          Cache.apiEndpoint = `http://127.0.0.1:${port}`
          console.log('API is responding at:', Cache.apiEndpoint)
          clearInterval(checkInterval)
          clearTimeout(startupTimeout)
          resolve(true)
        }
      }

      // Check API availability every 500ms
      const checkInterval = setInterval(waitForApi, 500)

      apiProcess.stdout.on('data', (data) => {
        const message = data.toString()
        console.log('Rclone API:', message.trim())
      })

      apiProcess.stderr.on('data', (data) => {
        const message = data.toString()
        if (!message.includes('Warning: Allow origin set to *')) {
          console.error('Rclone API Error:', message.trim())
        }
      })

      const startupTimeout = setTimeout(() => {
        if (!isStarted) {
          console.error('Rclone API server startup timeout')
          clearInterval(checkInterval)
          if (apiProcess.pid) {
            process.kill(-apiProcess.pid) // Kill process group
          }
          resolve(false)
        }
      }, 10000) // Увеличили таймаут до 10 секунд

      // Handle process exit
      apiProcess.on('close', (code) => {
        console.log(`Rclone API process exited with code ${code}`)
        if (!isStarted) {
          clearInterval(checkInterval)
          clearTimeout(startupTimeout)
          resolve(false)
        }
      })

      // Clean up on parent process exit
      process.on('exit', () => {
        if (apiProcess.pid) {
          process.kill(-apiProcess.pid)
        }
      })

      process.on('SIGINT', () => {
        if (apiProcess.pid) {
          process.kill(-apiProcess.pid)
        }
        process.exit()
      })

      process.on('SIGTERM', () => {
        if (apiProcess.pid) {
          process.kill(-apiProcess.pid)
        }
        process.exit()
      })

    } catch (error) {
      console.error('Failed to start Rclone API:', error)
      resolve(false)
    }
  })
}

/**
 * Update providers cache using correct API URL
 * @private
 */
const updateProvidersCache = async function() {
  try {
    const response = await makeRcloneRequest('POST', ApiUrls.providers)
    Cache.providers = {}
    
    Object.keys(response.providers).forEach(type => {
      if (!UnsupportedRcloneProviders.includes(type)) {
        Cache.providers[type] = {
          type,
          description: response.providers[type],
          requiresBucket: BucketRequiredProviders.includes(type)
        }
      }
    })
    
    if (isDev) {
      console.log('Updated providers cache:', Cache.providers)
    }
  } catch (error) {
    console.error('Failed to update providers cache:', error)
    throw new Error('Failed to get rclone providers')
  }
}
/**
 * Update bookmarks cache using correct API URL 
 * @private
 */
const updateBookmarksCache = async function() {
  try {
    const response = await makeRcloneRequest('POST', ApiUrls.configDump)
    Cache.bookmarks = {}

    Object.keys(response).forEach(name => {
      if (name !== 'RCLONE_ENCRYPT_V0') {
        const bookmark = response[name]
        bookmark.$name = name
        Cache.bookmarks[name] = bookmark
      }
    })

    if (isDev) {
      console.log('Updated bookmarks cache:', Cache.bookmarks)
    }
  } catch (error) {
    console.error('Failed to update bookmarks cache:', error)
    throw new Error('Failed to get rclone config')
  }
}

// Core functions
/**
 * Initialize rclone with correct API URLs
 */
const init = async function() {
  try {
    // Add /usr/local/bin to PATH on Unix systems
    if (process.platform === 'linux' || process.platform === 'darwin') {
      process.env.PATH += ':' + path.join('/', 'usr', 'local', 'bin')
    }

    // Try to start API server
    const apiStarted = await startRcloneAPI()
    
    if (apiStarted) {
      console.log('Rclone API server started successfully')
    } else {
      console.log('Running in CLI mode')
    }

    // Get version
    const versionResponse = await makeRcloneRequest('POST', 'core/version')
    Cache.version = versionResponse.version
    console.log('Rclone version:', Cache.version)

    // Set config file path
    Cache.configFile = settings.get('rclone_config') || path.join(app.getPath('userData'), 'rclone.conf')
    console.log('Using config file:', Cache.configFile)

    // Initialize caches
    await updateProvidersCache()
    await updateBookmarksCache()

    console.log('Rclone initialized successfully')
    
  } catch (error) {
    console.error('Failed to initialize rclone:', error)
    throw error
  }
}

const prepareQuit = async function() {
  await stopRcloneAPI()
}

// Provider functions
const getProvider = function(type) {
  if (!(type in Cache.providers)) {
    throw new Error(`Provider ${type} not found`)
  }
  return Cache.providers[type]
}

const getProviders = function() {
  return Cache.providers
}

// Bookmark functions
const getBookmark = function(id) {
  if (!(id in Cache.bookmarks)) {
    throw new Error(`Bookmark ${id} not found`)
  }
  return Cache.bookmarks[id]
}

const getBookmarks = function() {
  return Cache.bookmarks
}

const addBookmark = function(name, config) {
  config.$name = name
  Cache.bookmarks[name] = config
  
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
  rcloneConfig[name] = config
  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig))
  
  UpdateCallbacksRegistry.forEach(callback => callback())
}

const updateBookmark = function(name, config) {
  if (!(name in Cache.bookmarks)) {
    throw new Error(`Bookmark ${name} not found`)
  }
  
  config.$name = name
  Cache.bookmarks[name] = config
  
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
  rcloneConfig[name] = config
  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig))
  
  UpdateCallbacksRegistry.forEach(callback => callback())
}

const deleteBookmark = function(name) {
  if (!(name in Cache.bookmarks)) {
    throw new Error(`Bookmark ${name} not found`)
  }
  
  delete Cache.bookmarks[name]
  
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
  delete rcloneConfig[name]
  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig))
  
  UpdateCallbacksRegistry.forEach(callback => callback())
}

const getVersion = function() {
  return Cache.version
}

const onUpdate = function(callback) {
  UpdateCallbacksRegistry.push(callback)
}

// Mount functions - stubs for now
const mount = async function(bookmark) { return false }
const unmount = async function(bookmark) { return false }
const getMountStatus = function(bookmark) { return false }
const openMountPoint = async function(bookmark) { return false }

// Download/Upload functions - stubs for now
const download = async function(bookmark) { return false }
const stopDownload = async function(bookmark) { return false }
const isDownload = function(bookmark) { return false }
const upload = async function(bookmark) { return false }
const stopUpload = async function(bookmark) { return false }
const isUpload = function(bookmark) { return false }
const isAutomaticUpload = function(bookmark) { return false }
const toggleAutomaticUpload = async function(bookmark) { return false }
const openLocal = async function(bookmark) { return false }

// Server functions - stubs for now
const getAvailableServeProtocols = function() { return {} }
const serveStart = async function(bookmark, protocol) { return false }
const serveStop = async function(bookmark, protocol) { return false }
const serveStatus = function(protocol, bookmark) { return false }

// NCDU function - stub for now
const openNCDU = async function(bookmark) { return false }

// Exports
module.exports = {
  // Core functions
  init,
  prepareQuit,
  
  // Provider functions
  getProviders,
  getProvider,
  
  // Bookmark functions
  getBookmark,
  getBookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  
  // Mount functions
  mount,
  unmount,
  getMountStatus,
  openMountPoint,
  
  // Download/Upload functions
  download,
  stopDownload,
  isDownload,
  upload,
  stopUpload,
  isUpload,
  isAutomaticUpload,
  toggleAutomaticUpload,
  openLocal,
  
  // Server functions
  getAvailableServeProtocols,
  serveStart,
  serveStop,
  serveStatus,
  
  // NCDU function
  openNCDU,
  
  // Helper functions
  getVersion,
  onUpdate,
  
  // For testing/debugging
  Cache: isDev ? Cache : undefined
}