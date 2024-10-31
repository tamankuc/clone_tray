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
  servePoints: {}
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
 * Update providers cache by reading config
 * @private 
 */
const updateProvidersCache = async function() {
  try {
    const rcloneBinary = getRcloneBinary()
    
    // Get list of available providers from rclone config providers command
    const providersOutput = execSync(`${rcloneBinary} config providers`).toString()
    const providerLines = providersOutput.split('\n')
    
    Cache.providers = {}
    
    providerLines.forEach(line => {
      const match = line.match(/^\s*(\w+):\s*(.+)$/)
      if (match) {
        const [, type, description] = match
        if (!UnsupportedRcloneProviders.includes(type)) {
          Cache.providers[type] = {
            type,
            description,
            requiresBucket: BucketRequiredProviders.includes(type)
          }
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
 * Update bookmarks cache by reading config file
 * @private
 */
const updateBookmarksCache = async function() {
  try {
    if (!fs.existsSync(Cache.configFile)) {
      Cache.bookmarks = {}
      return
    }

    const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
    Cache.bookmarks = {}

    // Convert ini sections to bookmarks
    Object.keys(config).forEach(name => {
      if (name !== 'RCLONE_ENCRYPT_V0') {
        const bookmark = config[name]
        bookmark.$name = name // Add name reference
        Cache.bookmarks[name] = bookmark
      }
    })

    if (isDev) {
      console.log('Updated bookmarks cache:', Cache.bookmarks) 
    }
  } catch (error) {
    console.error('Failed to update bookmarks cache:', error)
    throw new Error('Failed to read rclone config')
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

    const rcloneBinary = getRcloneBinary()

    // Get rclone version
    Cache.version = execSync(`${rcloneBinary} version`).toString().split('\n')[0]
    
    // Get config file path
    if (settings.get('rclone_config')) {
      Cache.configFile = settings.get('rclone_config')
    } else {
      Cache.configFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf')
    }

    // Initialize caches
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
const prepareQuit = () => Promise.resolve()

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