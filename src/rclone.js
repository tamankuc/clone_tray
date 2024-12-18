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
const RcloneSyncService = require('./RcloneSyncService')
const logger = require('./LoggingService');
let apiService = null
let syncService = null

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
  apiEndpoint: null,
  syncPoints: new Map()
}

const UpdateCallbacksRegistry = []

let configWatcher = null;

/**
 * Настроить отслеживание изменений конфиг файла
 * @private
 */
const setupConfigWatcher = function() {
    if (configWatcher) {
        configWatcher.close();
    }

    try {
        let debounceTimer = null;
        const debounceDelay = 1000; // Задержка для избежания множественных обновлений

        configWatcher = fs.watch(Cache.configFile, async (eventType, filename) => {
            if (eventType === 'change') {
                // Используем debounce чтобы не обрабатывать множественные события
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }

                debounceTimer = setTimeout(async () => {
                    try {
                        logger.info('Config file changed, updating caches...');
                        
                        // Обновляем кеши
                        await updateBookmarksCache();
                        if (Cache.apiService) {
                            await updateMountPointsCache();
                        }

                        // Уведомляем пользователя
                        const dialogs = require('./dialogs');
                        dialogs.notification('Rclone config file has been updated');

                        // Обновляем меню
                        UpdateCallbacksRegistry.forEach(callback => callback());

                    } catch (error) {
                        logger.error('Error updating after config change:', error);
                        const dialogs = require('./dialogs');
                        dialogs.notification('Failed to update after config change: ' + error.message);
                    }
                }, debounceDelay);
            }
        });

        logger.info('Config watcher setup for:', Cache.configFile);
    } catch (error) {
        logger.error('Failed to setup config watcher:', error);
    }
};

/**
 * Очистить отслеживание конфиг файла
 * @private
 */
const cleanupConfigWatcher = function() {
    if (configWatcher) {
        configWatcher.close();
        configWatcher = null;
        logger.info('Config watcher cleaned up');
    }
};

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
          logger.info('API not initialized, falling back to CLI');
          return await executeCliCommand(endpoint, params);
      }

      return await Cache.apiService.makeRequest(endpoint, method, params);
  } catch (error) {
      logger.error('API request error:', error);
      logger.info('Falling back to CLI mode');
      return await executeCliCommand(endpoint, params);
  }
};

const executeCliCommand = async function(endpoint, params) {
  logger.info('Executing CLI command for endpoint:', endpoint)
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
        logger.error(`Unsupported CLI fallback for endpoint: ${endpoint}`)
        throw new Error(`Unsupported CLI fallback for endpoint: ${endpoint}`)
    }
  } catch (error) {
    logger.error('CLI execution failed:', error)
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
const getMountConfig = function(bookmark, mountName = 'default') {
  const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
  const sectionKey = mountName === 'default' ? bookmark.$name : `${bookmark.$name}.mount_${mountName}`;
  
  const mountConfig = {
      enabled: false,
      path: '',
      remotePath: '',
      options: { ...DEFAULT_MOUNT_OPTIONS._rclonetray_mount_options }
  };

  if (config[sectionKey]) {
      // Получаем путь в remote
      if ('_rclonetray_remote_path' in config[sectionKey]) {
          mountConfig.remotePath = config[sectionKey]._rclonetray_remote_path;
      }

      if ('_rclonetray_mount_enabled' in config[sectionKey]) {
          mountConfig.enabled = config[sectionKey]._rclonetray_mount_enabled === 'true';
      }

      if ('_rclonetray_mount_path' in config[sectionKey]) {
          mountConfig.path = config[sectionKey]._rclonetray_mount_path;
      }

      // Получаем опции монтирования
      Object.keys(config[sectionKey]).forEach(key => {
          if (key.startsWith('_rclonetray_mount_opt_')) {
              const optionName = '--' + key.replace('_rclonetray_mount_opt_', '');
              mountConfig.options[optionName] = config[sectionKey][key];
          }
      });
  }

  return mountConfig;
};

//**Получить все наборы настроек монтирования для закладки

const getMountOptionSets = function(bookmark) {
   const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
   const optionSets = [];
   const bookmarkName = bookmark.$name;

   // Добавляем стандартный маунт первым
   optionSets.push({
       name: 'Default Mount',
       id: 'default',
       config: {
           enabled: false,
           path: '',
           options: DEFAULT_MOUNT_OPTIONS._rclonetray_mount_options
       }
   });

   // Ищем дополнительные конфигурации
   Object.keys(config).forEach(section => {
       if (section.startsWith(`${bookmarkName}.mount_`) && section !== bookmarkName) {
           const mountName = section.split('mount_')[1];
           optionSets.push({
               name: `Mount ${mountName}`,
               id: mountName,
               config: getMountConfig(bookmark, mountName)
           });
       }
   });

   return optionSets;
};

/**
* Сохранить настройки монтирования в конфиг
* @private
*/
/**
 * Сохранить конфигурацию монтирования
 */
const saveMountConfig = function(bookmark, config, mountName = 'default') {
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
  const sectionKey = mountName === 'default' ? bookmark.$name : `${bookmark.$name}.mount_${mountName}`;

  if (!rcloneConfig[sectionKey]) {
      rcloneConfig[sectionKey] = {};
  }

  // Добавляем путь в remote
  if (config.remotePath) {
      rcloneConfig[sectionKey]._rclonetray_remote_path = config.remotePath;
  }

  // Сохраняем остальные настройки
  rcloneConfig[sectionKey]._rclonetray_mount_enabled = config.enabled.toString();
  
  if (config.path) {
      rcloneConfig[sectionKey]._rclonetray_mount_path = config.path;
  }

  Object.entries(config.options || {}).forEach(([key, value]) => {
      rcloneConfig[sectionKey][`_rclonetray_mount_opt_${key.replace('--', '')}`] = value;
  });

  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig));
  logger.info(`Mount config saved for ${bookmark.$name} (${mountName})`);
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
* Восстановить состояния монтирования
*/
const restoreMountStates = async function() {
  try {
      const bookmarks = getBookmarks();
      for (const bookmarkName in bookmarks) {
          const bookmark = bookmarks[bookmarkName];
          const config = getMountConfig(bookmark);
          
          if (config.enabled) {
              logger.info('Auto-mounting', bookmarkName);
              await mount(bookmark);
          }
      }
  } catch (error) {
      logger.error('Failed to restore mount states:', error);
  }
};

const stopRcloneAPI = async function() {
  if (Cache.apiProcess) {
    Cache.apiProcess.kill()
    Cache.apiProcess = null
    Cache.apiEndpoint = null
    logger.info('Rclone API stopped');
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
    logger.error('Failed to execute rclone command:', error)
    throw error
  }
}

const startRcloneAPI = async function() {
  return new Promise((resolve, reject) => {
      try {
          if (!settings.get('rclone_api_enable')) {
              logger.info('Rclone API disabled in settings, using CLI mode');
              resolve(false);
              return;
          }

          const port = settings.get('rclone_api_port');
          const rcloneBinary = getRcloneBinary();

          // Проверяем наличие rclone
          try {
              execSync(`${rcloneBinary} version`);
          } catch (error) {
              logger.error('Rclone binary not found:', error);
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
              // '--rc-enable-metrics',
              // '--rc-files',
              '--cache-dir=' + path.join(app.getPath('userData'), 'cache'),
              '--rc-user=user',
              '--rc-pass=pass',
              '--rc-allow-origin=*',
              '--no-check-certificate',
              '--log-level=DEBUG',
              '--log-file=' + settings.get('rclone_log_path'),
          ];

          logger.info('Starting Rclone API with command:', rcloneBinary, command.join(' '));
          dialogs.notification('Starting Rclone API')
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
                  logger.debug('API check failed:', error.message);
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
                      logger.info('API responding at:', Cache.apiEndpoint);
                      if (checkInterval) clearInterval(checkInterval);
                      if (startupTimeout) clearTimeout(startupTimeout);
                      resolve(true);
                  }
              } catch (error) {
                  logger.error('Error checking API:', error);
              }
          };

          // Обработчики событий процесса
          apiProcess.stdout.on('data', (data) => {
              const message = data.toString().trim();
              logger.info('Rclone API:', message);
          });

          apiProcess.stderr.on('data', (data) => {
              const message = data.toString().trim();
              logger.error('Rclone API Error:', message);
          });

          apiProcess.on('close', (code) => {
              logger.info(`Rclone API process exited with code ${code}`);
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
                      logger.error('Rclone API startup timeout exceeded');
                      if (checkInterval) clearInterval(checkInterval);
                      if (apiProcess.pid) {
                          try {
                              process.kill(apiProcess.pid);
                          } catch (err) {
                              logger.error('Error killing process:', err);
                          }
                      }
                      resolve(false);
                  }
              }, 15000);
          }, 2000);

      } catch (error) {
          logger.error('Failed to start Rclone API:', error);
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
    
    logger.debug('Updated providers cache:', Cache.providers);
  } catch (error) {
    logger.error('Failed to update providers cache:', error)
    throw new Error('Failed to get rclone providers')
  }
}

/**
 * Update bookmarks cache using correct API URL 
 * @private
 */
const updateBookmarksCache = async function() {
  try {
      const response = await makeRcloneRequest('POST', ApiUrls.configDump);
      Cache.bookmarks = {};

      Object.keys(response).forEach(name => {
          // Пропускаем служебные секции
          if (name === 'RCLONE_ENCRYPT_V0' || 
              name.includes('.mount_') || 
              name.includes('.sync_')) {
              return;
          }

          const bookmark = response[name];
          bookmark.$name = name;
          Cache.bookmarks[name] = bookmark;
      });

      logger.debug('Updated bookmarks cache:', Cache.bookmarks);
  } catch (error) {
      logger.error('Failed to update bookmarks cache:', error);
      throw new Error('Failed to get rclone config');
  }
}

//во время инициализации стартуем API
// и создаем сервисы
// и инициализируем кеш
//
const init = async function() {
  try {
    // Add /usr/local/bin to PATH on Unix systems
    if (process.platform === 'linux' || process.platform === 'darwin') {
      process.env.PATH += ':' + path.join('/', 'usr', 'local', 'bin')
    }

    logger.info('Initializing Rclone...');

    // Try to start API server
    const apiStarted = await startRcloneAPI()
    
    if (apiStarted) {
      logger.info('Rclone API server started successfully')
      // Создаем API сервис
      apiService = new RcloneApiService(settings.get('rclone_api_port'), 'user', 'pass')
      setupConfigWatcher();

      // Создаем Sync сервис с зависимостями
      syncService = new RcloneSyncService(
          apiService,
          getSyncConfig,  // Функция получения конфига
          saveSyncConfig  // Функция сохранения конфига
      );
      
      // Сохраняем в кеш
      Cache.apiService = apiService
      Cache.syncService = syncService
  } else {
      logger.info('Running in CLI mode')
    }

    // Get version
    const versionResponse = await makeRcloneRequest('POST', 'core/version')
    Cache.version = versionResponse.version
    logger.info('Rclone version:', Cache.version)

    // Set config file path
    Cache.configFile = settings.get('rclone_config') || path.join(app.getPath('userData'), 'rclone.conf')
    Cache.configFile = settings.get('rclone_config')
    logger.info('Using config file:', Cache.configFile)

    // Initialize caches
    await updateProvidersCache();
    await updateBookmarksCache();
    if (apiStarted) {
        await updateMountPointsCache();
    }

    logger.info('Rclone initialized successfully');
    
} catch (error) {
    logger.error('Failed to initialize rclone:', error);
    throw error;
}
}

const prepareQuit = async function() {
  logger.info('Preparing to quit...');
  cleanupConfigWatcher();
  if (syncService) {
      await syncService.cleanup();
  }
  await stopRcloneAPI();
  logger.info('Cleanup completed');
}

// Provider functions
const getProvider = function(type) {
  if (!(type in Cache.providers)) {
    logger.error(`Provider ${type} not found`);
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
    logger.error(`Bookmark ${id} not found`);
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
  
  logger.info(`Bookmark ${name} added`);
  UpdateCallbacksRegistry.forEach(callback => callback())
}

const updateBookmark = function(name, config) {
  if (!(name in Cache.bookmarks)) {
    logger.error(`Bookmark ${name} not found`);
    throw new Error(`Bookmark ${name} not found`)
  }
  
  config.$name = name
  Cache.bookmarks[name] = config
  
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
  rcloneConfig[name] = config
  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig))
  
  logger.info(`Bookmark ${name} updated`);
  UpdateCallbacksRegistry.forEach(callback => callback())
}

const deleteBookmark = function(name) {
  if (!(name in Cache.bookmarks)) {
    logger.error(`Bookmark ${name} not found`);
    throw new Error(`Bookmark ${name} not found`)
  }
  
  delete Cache.bookmarks[name]
  
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
  delete rcloneConfig[name]
  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig))
  
  logger.info(`Bookmark ${name} deleted`);
  UpdateCallbacksRegistry.forEach(callback => callback())
}

const getVersion = function() {
  return Cache.version
}

const onUpdate = function(callback) {
  UpdateCallbacksRegistry.push(callback)
}

/**
 * Форматирование ключа для кеша точек монтирования
 */
const getMountCacheKey = function(bookmarkName, mountName = 'default') {
  return `${bookmarkName}@@${mountName}`;
};

/**
 * Получить путь монтирования
 */
const getMountPath = function(bookmark, mountName = 'default') {
  const config = getMountConfig(bookmark, mountName);
  if (config.path) {
      return config.path;
  }
  
  // Используем системный временный каталог
  const mountDir = path.join(app.getPath('temp'), 'rclonetray-mounts');
  if (!fs.existsSync(mountDir)) {
      fs.mkdirSync(mountDir, { recursive: true });
  }
  
  return mountName === 'default' ? 
      path.join(mountDir, bookmark.$name) :
      path.join(mountDir, `${bookmark.$name}@@${mountName}`);
};

/**
* Получить статус монтирования
*/
const getMountStatus = function(bookmark, mountName = 'default') {
  const mountPointKey = getMountCacheKey(bookmark.$name, mountName);
  if (Cache.mountPoints[mountPointKey]) {
      return Cache.mountPoints[mountPointKey].path;
  }
  return false;
};

/**
 * Обновление кеша точек монтирования
 */
const updateMountPointsCache = async function() {
  try {
      const response = await Cache.apiService.listMounts();
      
      // Очищаем текущий кеш
      Cache.mountPoints = {};
      
      // Обновляем кеш монтирований
      if (response && response.mountPoints) {
          Object.entries(response.mountPoints).forEach(([mountPoint, remoteInfo]) => {
              const remotePath = remoteInfo.fs;
              const parts = remotePath.split(':');
              const remoteName = parts[0];
              
              // Проверяем путь монтирования на наличие маркера дополнительной точки
              const mountPathParts = mountPoint.split(path.sep);
              const lastPart = mountPathParts[mountPathParts.length - 1];
              
              let bookmarkName, mountName;
              if (lastPart.includes('@@')) {
                  [bookmarkName, mountName] = lastPart.split('@@');
              } else {
                  bookmarkName = remoteName;
                  mountName = 'default';
              }
              
              const cacheKey = getMountCacheKey(bookmarkName, mountName);
              Cache.mountPoints[cacheKey] = {
                  path: mountPoint,
                  remote: remotePath
              };
          });
      }
      
      logger.debug('Updated mount points cache:', Cache.mountPoints);
  } catch (error) {
      logger.error('Failed to update mount points cache:', error);
  }
};

/**
* Отмонтировать удаленную папку
*/
const unmount = async function(bookmark, mountName = 'default') {
  try {
      const cacheKey = getMountCacheKey(bookmark.$name, mountName);
      
      if (!Cache.mountPoints[cacheKey]) {
          logger.info('Not mounted:', bookmark.$name, mountName);
          return true;
      }

      const mountPoint = Cache.mountPoints[cacheKey].path;
      logger.info('Unmounting', mountPoint);
      dialogs.notification(`Successfully unmounted ${bookmark.$name}${mountName !== 'default' ? ` (${mountName})` : ''}`);

      await Cache.apiService.unmount(mountPoint);
      
      delete Cache.mountPoints[cacheKey];

      // Сохраняем состояние в конфиг
      const config = getMountConfig(bookmark, mountName);
      config.enabled = false;
      saveMountConfig(bookmark, config, mountName);

      // Уведомляем об изменениях
      UpdateCallbacksRegistry.forEach(callback => callback());

      return true;
  } catch (error) {
      logger.error('Unmount error:', error);
      dialogs.notification(`Failed to unmount ${bookmark.$name}: ${error.message}`);
      return false;
  }
};

/**
* Открыть точку монтирования в файловом менеджере
* @param {object} bookmark Закладка для открытия
*/
const openMountPoint = async function(bookmark) {
  const mountPoint = getMountStatus(bookmark);
  if (mountPoint) {
      await shell.openPath(mountPoint);
      logger.info(`Opened mount point for ${bookmark.$name}`);
      return true;
  }
  return false;
}

/**
 * Параметры синхронизации по умолчанию
 */
const DEFAULT_SYNC_OPTIONS = {
  enabled: false,
  localPath: '',
  remotePath: '',
  mode: 'bisync',
  direction: 'upload',
  _rclonetray_sync_initialized: 'false',
  transfers: '2',
  checkers: '4',
  'max-delete': '100'
};

/**
* Получить все точки синхронизации для закладки
*/
const getSyncOptionSets = function(bookmark) {
  const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
  const optionSets = [];
  const bookmarkName = bookmark.$name;

  console.log('Looking for sync configs for bookmark:', bookmarkName);

  // Ищем все секции конфигурации
  Object.keys(config).forEach(section => {
      // Проверяем, что это секция синхронизации для данной закладки
      if (section === `${bookmarkName}.sync_sync1` || 
          section.startsWith(`${bookmarkName}.sync_`)) {
          
          const syncName = section.split(`${bookmarkName}.sync_`)[1];
          // console.log('Found sync section:', section, 'with name:', syncName);
          
          const syncConfig = getSyncConfig(bookmark, syncName);
          if (syncConfig) {
              optionSets.push({
                  name: `Sync ${syncName}`,
                  id: syncName,
                  config: syncConfig
              });
          }
      }
  });

  // console.log(`Found ${optionSets.length} sync options for ${bookmarkName}:`, 
  //             optionSets);
  return optionSets;
};

/**
* Получить конфигурацию точки синхронизации
*/
// const getSyncConfig = function(bookmark, syncName) {
//   const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
//   const sectionKey = `${bookmark.$name}.sync_${syncName}`;
  
//   if (!config[sectionKey]) {
//       return null;
//   }

//   return {
//       enabled: config[sectionKey]._rclonetray_sync_enabled === 'true',
//       localPath: config[sectionKey]._rclonetray_sync_local_path || '',
//       remotePath: config[sectionKey]._rclonetray_sync_remote_path || '',
//       mode: config[sectionKey]._rclonetray_sync_mode || 'bisync',
//       direction: config[sectionKey]._rclonetray_sync_direction || 'upload'
//   };
// };

// /**
// * Сохранить конфигурацию точки синхронизации
// */
// const saveSyncConfig = function(bookmark, config, syncName) {
//   const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
//   const sectionKey = `${bookmark.$name}.sync_${syncName}`;

//   rcloneConfig[sectionKey] = {
//       _rclonetray_sync_enabled: config.enabled.toString(),
//       _rclonetray_sync_local_path: config.localPath,
//       _rclonetray_sync_remote_path: config.remotePath,
//       _rclonetray_sync_mode: config.mode,
//       _rclonetray_sync_direction: config.direction
//   };

//   fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig));
// };

/**
* Монтировать удаленную папку
*/
const mount = async function(bookmark, mountName = 'default') {
  try {
      const config = getMountConfig(bookmark, mountName);
      const mountPoint = getMountPath(bookmark, mountName);
      const cacheKey = getMountCacheKey(bookmark.$name, mountName);
      
      // 1. Проверяем и очищаем предыдущее состояние
      if (Cache.mountPoints[cacheKey]) {
          try {
              // Пытаемся размонтировать если точка осталась в кеше
              await Cache.apiService.unmount(Cache.mountPoints[cacheKey].path);
          } catch (err) {
              console.log('Cleanup previous mount state error:', err);
              // Игнорируем ошибку, просто логируем
          }
          delete Cache.mountPoints[cacheKey];
      }

      // 2. Проверяем существование директории
      try {
          await fs.promises.access(mountPoint);
      } catch (err) {
          // Директория не существует - создаем
          await fs.promises.mkdir(mountPoint, { recursive: true });
      }

      // 3. Проверяем, что директория пуста
      const files = await fs.promises.readdir(mountPoint);
      if (files.length > 0) {
          console.warn('Mount point not empty:', mountPoint);
          // Можно добавить очистку, если нужно
      }

      // 4. Формируем remote path
      const remoteName = bookmark.$name + ':';
      const remotePath = config.remotePath ? 
          path.posix.join(remoteName, config.remotePath) : 
          remoteName;

      // 5. Готовим параметры монтирования
      const mountParams = {
          fs: remotePath,
          mountPoint: mountPoint,
          mountOpt: {
              ...config.options,
              '--daemon': false,    // Важно: запускаем в foreground
              '--allow-other': true // Разрешаем доступ другим пользователям
          }
      };

      console.log('Mounting with params:', JSON.stringify(mountParams, null, 2));

      // 6. Делаем несколько попыток монтирования
      let retries = 3;
      let lastError = null;

      while (retries > 0) {
          try {
              // Пауза между попытками
              if (retries < 3) {
                  await new Promise(resolve => setTimeout(resolve, 1000));
              }

              await Cache.apiService.createMount(mountParams);
              
              // Проверяем успешность монтирования
              const mountCheck = await new Promise((resolve) => {
                  setTimeout(async () => {
                      try {
                          await fs.promises.access(mountPoint);
                          // Дополнительная проверка через listMounts
                          const mounts = await Cache.apiService.listMounts();
                          const isMounted = Object.values(mounts.mountPoints || {})
                              .some(m => m.MountPoint === mountPoint);
                          resolve(isMounted);
                      } catch (err) {
                          resolve(false);
                      }
                  }, 1000); // Даем время на монтирование
              });

              if (mountCheck) {
                  // 7. Обновляем кеш только после успешного монтирования
                  Cache.mountPoints[cacheKey] = {
                      path: mountPoint,
                      remote: remotePath,
                      options: mountParams.mountOpt
                  };

                  // 8. Сохраняем состояние
                  config.enabled = true;
                  saveMountConfig(bookmark, config, mountName);

                  // 9. Уведомляем об изменениях
                  UpdateCallbacksRegistry.forEach(callback => callback());

                  console.log('Successfully mounted:', mountPoint);
                  return true;
              }

              lastError = new Error('Mount verification failed');
              retries--;
          } catch (error) {
              console.error(`Mount attempt ${3 - retries + 1} failed:`, error);
              lastError = error;
              retries--;
          }
      }

      throw lastError || new Error('Failed to mount after retries');

  } catch (error) {
      console.error('Mount error:', error);
      dialogs.rcloneAPIError(`Failed to mount ${bookmark.$name}: ${error.message}`);
      return false;
  }
};
const createMountConfig = async function(bookmark, configName) {
  const defaultConfig = {
      enabled: false,
      path: '',
      options: DEFAULT_MOUNT_OPTIONS._rclonetray_mount_options
  }
  
  await saveMountConfig(bookmark, defaultConfig, configName)
  return defaultConfig
}

// Удаление конфигурации монтирования
const deleteMountConfig = async function(bookmark, configName) {
  const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'))
  const optionsKey = `${bookmark.$name}.${configName}`
  
  // Проверяем, не примонтирована ли эта конфигурация
  if (Cache.mountPoints[`${bookmark.$name}_${configName}`]) {
      throw new Error('Cannot delete mounted configuration')
  }
  
  // Удаляем секцию из конфига
  delete rcloneConfig[optionsKey]
  
  // Сохраняем конфиг
  fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig))
  
  // Обновляем кэш
  UpdateCallbacksRegistry.forEach(callback => callback())
}
// Constants
// const DEFAULT_SYNC_OPTIONS = {
//   '_rclonetray_sync_enabled': false,
//   '_rclonetray_sync_local_path': '',
//   '_rclonetray_sync_remote_path': '',
//   '_rclonetray_sync_mode': 'bisync',
//   '_rclonetray_sync_direction': 'upload'
// };

// Cache расширение
Cache.syncPoints = new Map();

/**
* Получить все точки синхронизации для закладки
*/
// const getSyncOptionSets = function(bookmark) {
//   const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
//   const optionSets = [];
//   const bookmarkName = bookmark.$name;

//   // Ищем конфигурации синхронизации
//   Object.keys(config).forEach(section => {
//       if (section.startsWith(`${bookmarkName}.sync_`)) {
//           const syncName = section.split('sync_')[1];
//           optionSets.push({
//               name: `Sync ${syncName}`,
//               id: syncName,
//               config: getSyncConfig(bookmark, syncName)
//           });
//       }
//   });

//   return optionSets;
// };

/**
 * Получить конфигурацию точки синхронизации
 * @param {Object} bookmark - Закладка, для которой получаем конфигурацию
 * @param {string} syncName - Имя конфигурации синхронизации
 * @returns {Object|null} - Конфигурация синхронизации или null, если не найдена
 */
const getSyncConfig = function(bookmark, syncName) {
  try {
      const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
      const sectionKey = `${bookmark.$name}.sync_${syncName}`;
      
      console.log('Getting sync config for section:', sectionKey);

      // Если секции нет в конфиге, возвращаем null
      if (!config[sectionKey]) {
          console.log('Sync config section not found:', sectionKey);
          return null;
      }

      // Считываем значения из конфига с fallback на значения по умолчанию
      const syncConfig = {
          name: syncName,
          enabled: config[sectionKey]._rclonetray_sync_enabled === 'true',
          localPath: config[sectionKey]._rclonetray_sync_local_path || DEFAULT_SYNC_OPTIONS.localPath,
          remotePath: config[sectionKey]._rclonetray_sync_remote_path || DEFAULT_SYNC_OPTIONS.remotePath,
          mode: config[sectionKey]._rclonetray_sync_mode || DEFAULT_SYNC_OPTIONS.mode,
          direction: config[sectionKey]._rclonetray_sync_direction || DEFAULT_SYNC_OPTIONS.direction,
          _rclonetray_sync_initialized: config[sectionKey]._rclonetray_sync_initialized || DEFAULT_SYNC_OPTIONS._rclonetray_sync_initialized,
          transfers: config[sectionKey]._rclonetray_sync_transfers || DEFAULT_SYNC_OPTIONS.transfers,
          checkers: config[sectionKey]._rclonetray_sync_checkers || DEFAULT_SYNC_OPTIONS.checkers,
          'max-delete': config[sectionKey]._rclonetray_sync_max_delete || DEFAULT_SYNC_OPTIONS['max-delete']
      };

      // Проверяем обязательные поля
      if (!syncConfig.localPath || !syncConfig.remotePath) {
          console.log('Missing required fields in sync config');
          return null;
      }

      console.log('Successfully loaded sync config:', syncConfig);
      return syncConfig;
  } catch (error) {
      console.error('Error reading sync config:', error);
      return null;
  }
};

/**
 * Сохранить конфигурацию точки синхронизации
 * @param {Object} bookmark - Закладка, для которой сохраняем конфигурацию
 * @param {Object} syncConfig - Конфигурация для сохранения
 * @param {string} syncName - Имя конфигурации синхронизации
 * @returns {boolean} - Успешность сохранения
 */
const saveSyncConfig = function(bookmark, syncConfig, syncName) {
  try {
      // Проверяем входные параметры
      if (!bookmark || !bookmark.$name || !syncConfig || !syncName) {
          throw new Error('Missing required parameters for saving sync config');
      }

      console.log('Saving sync config:', {
          bookmarkName: bookmark.$name,
          syncName: syncName,
          config: syncConfig
      });

      // Читаем текущий конфиг
      const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
      const sectionKey = `${bookmark.$name}.sync_${syncName}`;

      // Создаем или обновляем секцию
      config[sectionKey] = {
          // Основные настройки
          _rclonetray_sync_enabled: (syncConfig.enabled || DEFAULT_SYNC_OPTIONS.enabled).toString(),
          _rclonetray_sync_local_path: syncConfig.localPath || DEFAULT_SYNC_OPTIONS.localPath,
          _rclonetray_sync_remote_path: syncConfig.remotePath || DEFAULT_SYNC_OPTIONS.remotePath,
          _rclonetray_sync_mode: syncConfig.mode || DEFAULT_SYNC_OPTIONS.mode,
          _rclonetray_sync_direction: syncConfig.direction || DEFAULT_SYNC_OPTIONS.direction,
          
          // Статус инициализации
          _rclonetray_sync_initialized: syncConfig._rclonetray_sync_initialized || DEFAULT_SYNC_OPTIONS._rclonetray_sync_initialized,
          
          // Дополнительные параметры
          _rclonetray_sync_transfers: syncConfig.transfers || DEFAULT_SYNC_OPTIONS.transfers,
          _rclonetray_sync_checkers: syncConfig.checkers || DEFAULT_SYNC_OPTIONS.checkers,
          _rclonetray_sync_max_delete: syncConfig['max-delete'] || DEFAULT_SYNC_OPTIONS['max-delete']
      };

      // Сохраняем конфиг в файл
      fs.writeFileSync(Cache.configFile, ini.stringify(config));
      
      // Обновляем кэш, если необходимо
      if (Cache.syncPoints) {
          const cacheKey = getSyncCacheKey(bookmark.$name, syncName);
          Cache.syncPoints.set(cacheKey, { config: syncConfig });
      }

      console.log('Successfully saved sync config for:', sectionKey);
      
      // Уведомляем об изменениях
      if (UpdateCallbacksRegistry) {
          UpdateCallbacksRegistry.forEach(callback => callback());
      }

      return true;
  } catch (error) {
      console.error('Error saving sync config:', error);
      throw error;
  }
};

/**
 * Создать новую конфигурацию синхронизации
 * @param {Object} bookmark - Закладка
 * @param {string} syncName - Имя новой конфигурации
 * @returns {Object} - Созданная конфигурация
 */
const createSyncConfig = async function(bookmark, syncName) {
  const newConfig = { ...DEFAULT_SYNC_OPTIONS, name: syncName };
  await saveSyncConfig(bookmark, newConfig, syncName);
  return newConfig;
};

/**
* Удалить конфигурацию синхронизации
* @param {Object} bookmark - Закладка
* @param {string} syncName - Имя конфигурации для удаления
* @returns {boolean} - Успешность удаления
*/
const deleteSyncConfig = function(bookmark, syncName) {
  try {
      const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
      const sectionKey = `${bookmark.$name}.sync_${syncName}`;

      // Проверяем, не активна ли синхронизация
      const cacheKey = getSyncCacheKey(bookmark.$name, syncName);
      if (Cache.syncPoints && Cache.syncPoints.has(cacheKey)) {
          throw new Error('Cannot delete active sync configuration');
      }

      // Удаляем секцию из конфига
      if (config[sectionKey]) {
          delete config[sectionKey];
          fs.writeFileSync(Cache.configFile, ini.stringify(config));
          
          // Уведомляем об изменениях
          if (UpdateCallbacksRegistry) {
              UpdateCallbacksRegistry.forEach(callback => callback());
          }
          
          console.log('Successfully deleted sync config:', sectionKey);
          return true;
      }

      return false;
  } catch (error) {
      console.error('Error deleting sync config:', error);
      throw error;
  }
};


/**
* Форматирование ключа для кеша точек синхронизации
*/
const getSyncCacheKey = function(bookmarkName, syncName) {
  return `${bookmarkName}@@sync_${syncName}`;
};

/**
* Получить статус синхронизации
*/
const getSyncStatus = function(bookmark, syncName) {
  return syncService ? syncService.getSyncStatus(bookmark, syncName) : false
}

const startSync = async function(bookmark, syncName) {
  return syncService ? await syncService.startSync(bookmark, syncName) : false
}

const stopSync = async function(bookmark, syncName) {
  return syncService ? await syncService.stopSync(bookmark, syncName) : false
}

/**
* Мониторинг процесса синхронизации
*/
const _monitorSync = async function(bookmarkName, syncName) {
  const cacheKey = getSyncCacheKey(bookmarkName, syncName);
  const syncInfo = Cache.syncPoints.get(cacheKey);
  
  if (!syncInfo) {
      return;
  }

  try {
      const status = await Cache.apiService.makeRequest('job/status', 'POST', {
          jobid: syncInfo.jobId
      });

      if (status.finished) {
          if (status.error) {
              console.error('Sync error:', status.error);
              Cache.syncPoints.delete(cacheKey);
          } else {
              // Для bisync запускаем новую сессию
              if (syncInfo.mode === 'bisync') {
                  const bookmark = getBookmark(bookmarkName);
                  if (bookmark) {
                      startSync(bookmark, syncName);
                  }
              } else {
                  Cache.syncPoints.delete(cacheKey);
              }
          }
          return;
      }

      // Продолжаем мониторинг
      setTimeout(() => _monitorSync(bookmarkName, syncName), 1000);
  } catch (error) {
      console.error('Monitor sync error:', error);
      Cache.syncPoints.delete(cacheKey);
  }
};

// Download/Upload functions - stubs for now
const download = async function(bookmark) {
    if (!syncService) return false;
    return await syncService.startDownload(bookmark);
};

const stopDownload = async function(bookmark) {
    if (!syncService) return false;
    return await syncService.stopDownload(bookmark);
};

const isDownload = function(bookmark) {
    return syncService ? syncService.isDownloading(bookmark) : false;
};

const upload = async function(bookmark) {
    if (!syncService) return false;
    return await syncService.startUpload(bookmark);
};

const stopUpload = async function(bookmark) {
    if (!syncService) return false;
    return await syncService.stopUpload(bookmark);
};

const isUpload = function(bookmark) {
    return syncService ? syncService.isUploading(bookmark) : false;
};

const isAutomaticUpload = function(bookmark) {
    return syncService ? syncService.isAutoUploadEnabled(bookmark) : false;
};

const toggleAutomaticUpload = async function(bookmark) {
    if (!syncService) return false;
    return await syncService.toggleAutoUpload(bookmark);
};

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
  getMountConfig,
  getMountPath,
  createMountConfig,
  deleteMountConfig,
  getMountOptionSets,
  // For testing/debugging
  DEFAULT_MOUNT_OPTIONS,
  getMountConfig,
  getMountPath,
  createMountConfig,
  deleteMountConfig,
  getMountOptionSets,
  saveMountConfig,
  Cache: isDev ? Cache : undefined,
  
  // Sync functions
  getSyncOptionSets,
  getSyncConfig,
  saveSyncConfig,
  startSync,
  stopSync,
  getSyncStatus,

  
  // For testing/debugging
  Cache: isDev ? Cache : undefined,
  DEFAULT_MOUNT_OPTIONS,
  DEFAULT_SYNC_OPTIONS,
  isDownload,
  isUpload,
  isAutomaticUpload,

}
