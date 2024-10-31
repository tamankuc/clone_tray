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

/**
 * Define unsupported provider types
 * @private
 */
const UnsupportedRcloneProviders = [
  'union',
  'crypt'
]

/**
 * Define providers that require buckets and cannot works with root.
 * @private
 */
const BucketRequiredProviders = [
  'b2',
  'swift', 
  's3',
  'gsc',
  'hubic'
]

/**
 * Rclone executable filename
 * @private
 */
const RcloneBinaryName = process.platform === 'win32' ? 'rclone.exe' : 'rclone'

/**
 * Bundled Rclone path
 * @private
 */
const RcloneBinaryBundled = app.isPackaged
  ? path.join(process.resourcesPath, 'rclone', process.platform, RcloneBinaryName)
  : path.join(app.getAppPath(), 'rclone', process.platform, RcloneBinaryName) 

/**
 * System's temp directory
 * @private
 */
const tempDir = app.getPath('temp')

/**
 * Cache for Rclone settings
 * @private
 */
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

/**
 * @private
 */
const UpdateCallbacksRegistry = []

/**
 * Get rclone binary path based on settings
 * @private
 */
const getRcloneBinary = function() {
  return settings.get('rclone_use_bundled') ? RcloneBinaryBundled : RcloneBinaryName
}

/**
 * Make request to Rclone API
 * @param {string} method 
 * @param {string} endpoint
 * @param {object} body
 * @returns {Promise}
 * @private
 */
const makeRcloneRequest = async function(method, endpoint, body = null) {
  try {
    if (!Cache.apiEndpoint) {
      throw new Error('Rclone API not initialized')
    }

    const url = `${Cache.apiEndpoint}${endpoint}`
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    }

    if (body) {
      options.body = JSON.stringify(body)
    }

    // Add authentication if enabled
    if (settings.get('rclone_api_auth_enable')) {
      const auth = Buffer.from(`${settings.get('rclone_api_username')}:${settings.get('rclone_api_password')}`).toString('base64')
      options.headers['Authorization'] = `Basic ${auth}`
    }

    if (isDev) {
      console.log(`Making API request: ${method} ${url}`)
    }

    const response = await fetch(url, options)
    
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`)
    }

    const data = await response.json()

    if (isDev) {
      console.log('API response:', data)
    }

    return data
  } catch (error) {
    console.error('API request failed:', error)
    throw error
  }
}

/**
 * Start Rclone API server
 * @private
 */
const startRcloneAPI = async function() {
  return new Promise((resolve, reject) => {
    try {
      if (!settings.get('rclone_api_enable')) {
        console.log('Rclone API disabled in settings')
        resolve()
        return
      }

      const port = settings.get('rclone_api_port')
      const rcloneBinary = getRcloneBinary()

      // Build command array
      const command = [
        'rcd',
        '--rc-no-auth',
        `--rc-addr=127.0.0.1:${port}`
      ]

      // Add authentication if enabled
      if (settings.get('rclone_api_auth_enable')) {
        command.push(
          `--rc-user=${settings.get('rclone_api_username')}`,
          `--rc-pass=${settings.get('rclone_api_password')}`
        )
      }

      // Add config file if specified
      if (settings.get('rclone_config')) {
        command.push(`--config=${settings.get('rclone_config')}`)
      }

      // Add CORS settings
      command.push(`--rc-allow-origin=${settings.get('rclone_rc_allow_origin')}`)

      if (isDev) {
        console.log('Starting Rclone API with command:', rcloneBinary, command.join(' '))
      }

      // Start Rclone API server
      const apiProcess = spawn(rcloneBinary, command, {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      // Store process reference
      Cache.apiProcess = apiProcess
      Cache.apiEndpoint = `http://127.0.0.1:${port}`

      // Handle stdout
      apiProcess.stdout.on('data', (data) => {
        const message = data.toString()
        if (isDev) {
          console.log('Rclone API:', message)
        }
        // Resolve when API server is ready
        if (message.includes('Serving remote control on')) {
          resolve()
        }
      })

      // Handle stderr
      apiProcess.stderr.on('data', (data) => {
        const message = data.toString()
        console.error('Rclone API Error:', message)
      })

      // Handle process exit
      apiProcess.on('close', (code) => {
        console.log(`Rclone API process exited with code ${code}`)
        Cache.apiProcess = null
        Cache.apiEndpoint = null
        
        if (code !== 0) {
          dialogs.rcloneAPIError('Rclone API process has exited unexpectedly')
          // Try to restart API server
          startRcloneAPI().catch(console.error)
        }
      })

    } catch (error) {
      console.error('Failed to start Rclone API:', error)
      reject(error)
    }
  })
}

/**
 * Stop Rclone API server
 * @private
 */
const stopRcloneAPI = async function() {
  if (Cache.apiProcess) {
    Cache.apiProcess.kill()
    Cache.apiProcess = null
    Cache.apiEndpoint = null
  }
}

/**
 * Execute Rclone command via API
 * @param {string} command 
 * @param {object} options
 * @returns {Promise}
 * @private
 */
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

/**
 * Update providers cache using API
 * @private
 */
const updateProvidersCache = async function() {
  try {
    const response = await makeRcloneRequest('POST', '/config/providers')
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
 * Update bookmarks cache using API 
 * @private
 */
const updateBookmarksCache = async function() {
  try {
    const response = await makeRcloneRequest('POST', '/config/dump')
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

/**
 * Initialize rclone
 */
const init = async function() {
  try {
    // On linux and mac add /usr/local/bin to PATH
    if (process.platform === 'linux' || process.platform === 'darwin') {
      process.env.PATH += ':' + path.join('/', 'usr', 'local', 'bin')
    }

    // Start API server
    await startRcloneAPI()
    console.log('Rclone API server started successfully')

    // Get version via API
    const versionResponse = await makeRcloneRequest('POST', '/core/version')
    Cache.version = versionResponse.version
    
    // Get config file path
    if (settings.get('rclone_config')) {
      Cache.configFile = settings.get('rclone_config')
    } else {
      const configResponse = await makeRcloneRequest('POST', '/config/path')
      Cache.configFile = configResponse.path
    }

    // Initialize caches via API
    await updateProvidersCache()
    await updateBookmarksCache()

    if (isDev) {
      console.log('Rclone initialized successfully')
      console.log('Version:', Cache.version)
      console.log('Config:', Cache.configFile)
    }
  } catch (error) {
    console.error('Failed to initialize rclone:', error)
    throw error
  }
}

/**
 * Clean up before quit
 */
const prepareQuit = async function() {
  await stopRcloneAPI()
}

// Rest of the functions remain the same...
const getProvider = function(type) {
  if (!(type in Cache.providers)) {
    throw new Error(`Provider ${type} not found`)
  }
  return Cache.providers[type]
}

const getProviders = function() {
  return Cache.providers
}

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
  // Add to cache
  config.$name = name
  Cache.bookmarks[name] = config

  // Update config file
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
  rcloneConfig[name] = config
  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig))

  // Notify listeners
  UpdateCallbacksRegistry.forEach(callback => callback())
}

const updateBookmark = function(name, config) {
  if (!(name in Cache.bookmarks)) {
    throw new Error(`Bookmark ${name} not found`)
  }

  // Update cache
  config.$name = name
  Cache.bookmarks[name] = config

  // Update config file
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
  rcloneConfig[name] = config
  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig))

  // Notify listeners
  UpdateCallbacksRegistry.forEach(callback => callback())
}

const deleteBookmark = function(name) {
  if (!(name in Cache.bookmarks)) {
    throw new Error(`Bookmark ${name} not found`)
  }

  // Remove from cache
  delete Cache.bookmarks[name]

  // Update config file
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
  delete rcloneConfig[name]
  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig))

  // Notify listeners
  UpdateCallbacksRegistry.forEach(callback => callback())
}

const getVersion = function() {
  return Cache.version
}

const onUpdate = function(callback) {
  UpdateCallbacksRegistry.push(callback)
}

// Temporary stubs
const mount = () => false
const unmount = () => false
const getMountStatus = () => false
const openMountPoint = () => false
const download = () => false 
const stopDownload = () => false
const isDownload = () => false
const upload = () => false
const stopUpload = () => false
const isUpload = () => false
const isAutomaticUpload = () => false
const toggleAutomaticUpload = () => false
const openLocal = () => false
const getAvailableServeProtocols = () => ({})
const serveStart = () => false
const serveStop = () => false
const serveStatus = () => false
const openNCDU = () => false

module.exports = {
  getProviders,
  getProvider, 
  getBookmark,
  getBookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  mount,
  unmount,
  getMountStatus,
  openMountPoint,
  download,
  stopDownload,
  isDownload,
  upload,
  stopUpload,
  isUpload,
  isAutomaticUpload,
  toggleAutomaticUpload,
  openLocal,
  getAvailableServeProtocols,
  serveStart,
  serveStop,
  serveStatus,
  openNCDU,
  getVersion,
  onUpdate,
  init,
  prepareQuit
}