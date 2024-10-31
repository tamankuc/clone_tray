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
const RcloneApiService = require('./RcloneApiService');
let apiService = null;
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
 * Make request to Rclone API with retry
 * @param {string} method 
 * @param {string} endpoint
 * @param {object} params
 * @returns {Promise}
 * @private
 */
const makeRcloneRequest = async function(method, endpoint, params = null) {
  try {
      if (!Cache.apiService) {
          console.log('API не инициализирован, возврат к CLI');
          return await executeCliCommand(endpoint, params);
      }

      return await Cache.apiService.makeRequest(endpoint, method, params);
  } catch (error) {
      console.error('Ошибка API запроса:', error);
      console.error('Возврат к CLI режиму');
      return await executeCliCommand(endpoint, params);
  }
};

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

/**
 * Параметры монтирования по умолчанию
 * @private
 */
const DEFAULT_MOUNT_OPTIONS = {
  '_rclonetray_mount_enabled': false,     // Включено ли автомонтирование
  '_rclonetray_mount_path': '',           // Кастомный путь монтирования (если пусто - используется стандартный)
  '_rclonetray_mount_options': {          // Дополнительные опции монтирования
      '--vfs-cache-mode': 'writes',
      '--dir-cache-time': '30m',
      '--vfs-cache-max-age': '24h',
      '--vfs-read-ahead': '128M',
      '--buffer-size': '32M'
  }
};

/**
* Получить настройки монтирования из конфига
* @private
*/
const getMountConfig = function(bookmark) {
  const mountConfig = {
      enabled: false,
      path: '',
      options: {}
  };

  if (bookmark.options) {
      // Получаем значение enabled
      if ('_rclonetray_mount_enabled' in bookmark.options) {
          mountConfig.enabled = bookmark.options._rclonetray_mount_enabled === 'true';
      }

      // Получаем кастомный путь
      if ('_rclonetray_mount_path' in bookmark.options) {
          mountConfig.path = bookmark.options._rclonetray_mount_path;
      }

      // Получаем дополнительные опции
      Object.keys(bookmark.options).forEach(key => {
          if (key.startsWith('_rclonetray_mount_opt_')) {
              const optionName = '--' + key.replace('_rclonetray_mount_opt_', '');
              mountConfig.options[optionName] = bookmark.options[key];
          }
      });
  }

  return mountConfig;
};

/**
* Сохранить настройки монтирования в конфиг
* @private
*/
const saveMountConfig = function(bookmark, config) {
  if (!bookmark.options) {
      bookmark.options = {};
  }

  // Сохраняем enabled
  bookmark.options._rclonetray_mount_enabled = config.enabled.toString();

  // Сохраняем путь
  if (config.path) {
      bookmark.options._rclonetray_mount_path = config.path;
  } else {
      delete bookmark.options._rclonetray_mount_path;
  }

  // Сохраняем опции
  Object.keys(bookmark.options).forEach(key => {
      if (key.startsWith('_rclonetray_mount_opt_')) {
          delete bookmark.options[key];
      }
  });

  Object.entries(config.options).forEach(([key, value]) => {
      const optionKey = '_rclonetray_mount_opt_' + key.replace('--', '');
      bookmark.options[optionKey] = value;
  });

  // Сохраняем в конфиг
  updateBookmark(bookmark.$name, bookmark);
};



/**
* Получить опции монтирования
* @private
*/
const getMountOptions = function(bookmark) {
  const config = getMountConfig(bookmark);
  return {
      ...DEFAULT_MOUNT_OPTIONS._rclonetray_mount_options,
      ...config.options
  };
};

/**
* Монтировать удаленную папку
* @param {object} bookmark Закладка для монтирования
* @returns {Promise<boolean>}
*/


/**
* Размонтировать удаленную папку
* @param {object} bookmark Закладка для размонтирования
* @returns {Promise<boolean>}
*/


/**
* Восстановить состояния монтирования
*/
const restoreMountStates = async function() {
  try {
      const bookmarks = getBookmarks();
      for (const bookmarkName in bookmarks) {
          const bookmark = bookmarks[bookmarkName];
          const config = getMountConfig(bookmark);
          
          if (config.enabled) {
              console.log('Auto-mounting', bookmarkName);
              await mount(bookmark);
          }
      }
  } catch (error) {
      console.error('Failed to restore mount states:', error);
  }
};


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
              console.log('Rclone API отключен в настройках, используется режим CLI');
              resolve(false);
              return;
          }

          const port = settings.get('rclone_api_port');
          const rcloneBinary = getRcloneBinary();

          // Проверяем наличие rclone
          try {
              execSync(`${rcloneBinary} version`);
          } catch (error) {
              console.error('Не найден бинарный файл rclone:', error);
              resolve(false);
              return;
          }

          // Инициализируем сервис API
          const apiService = new RcloneApiService(port, 'user', 'pass');

          // Формируем команду запуска с обновленными параметрами
          const command = [
              'rcd',
              `--rc-addr=127.0.0.1:${port}`,
              `--config=${settings.get('rclone_config')}`,
              '--rc-enable-metrics',
              '--rc-files',
              '--cache-dir=' + path.join(app.getPath('userData'), 'cache'),
              '--rc-user=user',
              '--rc-pass=pass',
              '--rc-allow-origin=*'
          ];

          if (isDev) {
              command.push('--verbose');
          }

          console.log('Запуск Rclone API с командой:', rcloneBinary, command.join(' '));

          const apiProcess = spawn(rcloneBinary, command, {
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: false
          });

          let isStarted = false;
          let checkInterval = null;
          let startupTimeout = null;

          // Функция проверки API
          const checkApi = async () => {
              try {
                  return await apiService.checkConnection();
              } catch (error) {
                  console.log('API check failed:', error.message);
                  return false;
              }
          };

          const waitForApi = async () => {
              try {
                  if (await checkApi()) {
                      isStarted = true;
                      Cache.apiProcess = apiProcess;
                      Cache.apiEndpoint = `http://127.0.0.1:${port}`;
                      Cache.apiService = apiService;
                      console.log('API отвечает по адресу:', Cache.apiEndpoint);
                      if (checkInterval) clearInterval(checkInterval);
                      if (startupTimeout) clearTimeout(startupTimeout);
                      resolve(true);
                  }
              } catch (error) {
                  console.error('Ошибка при проверке API:', error);
              }
          };

          // Обработчики событий процесса
          apiProcess.stdout.on('data', (data) => {
              const message = data.toString().trim();
              console.log('Rclone API:', message);
          });

          apiProcess.stderr.on('data', (data) => {
              const message = data.toString().trim();
              console.error('Ошибка Rclone API:', message);
          });

          apiProcess.on('close', (code) => {
              console.log(`Процесс Rclone API завершился с кодом ${code}`);
              if (!isStarted) {
                  if (checkInterval) clearInterval(checkInterval);
                  if (startupTimeout) clearTimeout(startupTimeout);
                  resolve(false);
              }
          });

          // Даем процессу время на запуск перед первой проверкой
          setTimeout(() => {
              checkInterval = setInterval(waitForApi, 1000);
              
              startupTimeout = setTimeout(() => {
                  if (!isStarted) {
                      console.error('Превышено время запуска Rclone API');
                      if (checkInterval) clearInterval(checkInterval);
                      if (apiProcess.pid) {
                          try {
                              process.kill(apiProcess.pid);
                          } catch (err) {
                              console.error('Ошибка при завершении процесса:', err);
                          }
                      }
                      resolve(false);
                  }
              }, 15000);
          }, 2000);

      } catch (error) {
          console.error('Не удалось запустить Rclone API:', error);
          resolve(false);
      }
  });
};


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
    await updateProvidersCache();
    await updateBookmarksCache();
    if (apiStarted) {
        await updateMountPointsCache();
    }

    console.log('Rclone initialized successfully');
    
} catch (error) {
    console.error('Failed to initialize rclone:', error);
    throw error;
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

/**
* Получить путь для монтирования закладки
* @private
*/
const getMountPath = function(bookmark) {
  const config = getMountConfig(bookmark);
  if (config.path) {
      return config.path;
  }
  
  const mountDir = "/tmp/lol3";
  // const mountDir = path.join(app.getPath('userData'), 'mounts');
  if (!fs.existsSync(mountDir)) {
      fs.mkdirSync(mountDir, { recursive: true });
  }
  return path.join(mountDir);
  // return path.join(mountDir, bookmark.$name);
};
/**
* Монтировать удаленную папку
* @param {object} bookmark Закладка для монтирования
* @returns {Promise<boolean>}
*/


const updateMountPointsCache = async function() {
  try {
      // Получаем список текущих монтирований
      const response = await Cache.apiService.listMounts();
      
      // Очищаем текущий кеш
      Cache.mountPoints = {};
      
      // Обновляем кеш монтирований
      if (response && response.mountPoints) {
          Object.entries(response.mountPoints).forEach(([mountPoint, remoteInfo]) => {
              const remoteName = remoteInfo.fs.split(':')[0];
              Cache.mountPoints[remoteName] = {
                  path: mountPoint,
                  remote: remoteInfo.fs
              };
          });
      }
      
      if (isDev) {
          console.log('Updated mount points cache:', Cache.mountPoints);
      }
  } catch (error) {
      console.error('Failed to update mount points cache:', error);
  }
}
/**
* Отмонтировать удаленную папку
* @param {object} bookmark Закладка для размонтирования
* @returns {Promise<boolean>}
*/
const unmount = async function(bookmark) {
  try {
      if (!Cache.mountPoints[bookmark.$name]) {
          console.log('Not mounted:', bookmark.$name);
          return true;
      }

      const mountPoint = Cache.mountPoints[bookmark.$name].path;
      console.log('Unmounting', mountPoint);

      await Cache.apiService.unmount(mountPoint);
      
      delete Cache.mountPoints[bookmark.$name];

      // Сохраняем состояние в конфиг
      const config = getMountConfig(bookmark);
      config.enabled = false;
      saveMountConfig(bookmark, config);

      // Уведомляем об изменениях
      UpdateCallbacksRegistry.forEach(callback => callback());

      return true;
  } catch (error) {
      console.error('Unmount error:', error);
      dialogs.rcloneAPIError(`Failed to unmount ${bookmark.$name}: ${error.message}`);
      return false;
  }
};

/**
* Получить статус монтирования закладки
* @param {object} bookmark Закладка для проверки
* @returns {boolean|string} false если не смонтировано, путь монтирования если смонтировано
*/
const getMountStatus = function(bookmark) {
  if (Cache.mountPoints[bookmark.$name]) {
      return Cache.mountPoints[bookmark.$name].path;
  }
  return false;
}

/**
* Открыть точку монтирования в файловом менеджере
* @param {object} bookmark Закладка для открытия
*/
const openMountPoint = async function(bookmark) {
  const mountPoint = getMountStatus(bookmark);
  if (mountPoint) {
      await shell.openPath(mountPoint);
      return true;
  }
  return false;
}


// Mount functions - stubs for now
/**
 * Монтировать удаленную папку
 * @param {object} bookmark Закладка для монтирования
 * @returns {Promise<boolean>}
 */
/**
 * Монтировать удаленную папку
 * @param {object} bookmark Закладка для монтирования
 * @returns {Promise<boolean>}
 */
const mount = async function(bookmark) {
  try {
      const mountPoint = getMountPath(bookmark);
      
      // Проверяем, не смонтировано ли уже
      if (Cache.mountPoints[bookmark.$name]) {
          console.log('Already mounted:', bookmark.$name);
          return true;
      }

      // Создаем директорию для монтирования если её нет
      if (!fs.existsSync(mountPoint)) {
          fs.mkdirSync(mountPoint, { recursive: true });
      }

      // Формируем имя remote и опции
      const remoteName = bookmark.$name + ':';
      const options = getMountOptions(bookmark);

      console.log('Mounting', remoteName, 'to', mountPoint, 'with options:', options);

      // Собираем параметры для API в правильном формате
      const mountParams = {
          fs: remoteName,
          mountPoint: mountPoint,
          mountOpt: options
      };

      await Cache.apiService.createMount(mountParams);
      
      // Сохраняем информацию о монтировании
      Cache.mountPoints[bookmark.$name] = {
          path: mountPoint,
          remote: remoteName,
          options: options
      };

      // Сохраняем состояние в конфиг
      const config = getMountConfig(bookmark);
      config.enabled = true;
      saveMountConfig(bookmark, config);

      console.log(`Successfully mounted ${bookmark.$name} at ${mountPoint}`);

      // Уведомляем об изменениях
      UpdateCallbacksRegistry.forEach(callback => callback());

      return true;
  } catch (error) {
      console.error('Mount error:', error);
      dialogs.rcloneAPIError(`Failed to mount ${bookmark.$name}: ${error.message}`);
      return false;
  }
};
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