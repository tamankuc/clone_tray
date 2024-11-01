// src/services/rclone/rclone.js
const { spawn } = require('child_process');
const { app } = require('electron');
const path = require('path');
const settings = require('../../settings');
const Cache = require('./cache');
const RcloneApiService = require('./api.service');
const RcloneMountService = require('./mount.service');
const RcloneSyncService = require('./sync.service');
const { executeCliCommand, getRcloneBinary } = require('./utils');
const {
  ApiUrls,
  DEFAULT_MOUNT_OPTIONS,
  DEFAULT_SYNC_OPTIONS,
  isDev
} = require('./constants');

let apiService = null;
let mountService = null;
let syncService = null;
const UpdateCallbacksRegistry = [];

/**
 * Make request to Rclone API with retry
 */
const makeRcloneRequest = async function(method, endpoint, params = null) {
  try {
    if (!Cache.apiService) {
      console.log('API not initialized, falling back to CLI');
      return await executeCliCommand(endpoint, params);
    }

    return await Cache.apiService.makeRequest(endpoint, method, params);
  } catch (error) {
    console.error('API request failed:', error);
    console.error('Falling back to CLI mode');
    return await executeCliCommand(endpoint, params);
  }
};

/**
 * Start Rclone API server
 */
const startRcloneAPI = async function() {
  return new Promise((resolve, reject) => {
    try {
      if (!settings.get('rclone_api_enable')) {
        console.log('Rclone API disabled in settings, using CLI mode');
        resolve(false);
        return;
      }

      const port = settings.get('rclone_api_port');
      const rcloneBinary = getRcloneBinary();

      try {
        execSync(`${rcloneBinary} version`);
      } catch (error) {
        console.error('Rclone binary not found:', error);
        resolve(false);
        return;
      }

      const apiService = new RcloneApiService(port, 'user', 'pass');

      const command = [
        'rcd',
        `--rc-addr=127.0.0.1:${port}`,
        `--config=${settings.get('rclone_config')}`,
        '--rc-enable-metrics',
        '--rc-files',
        '--cache-dir=' + path.join(app.getPath('userData'), 'cache'),
        '--rc-user=user',
        '--rc-pass=pass',
        '--rc-allow-origin=*',
        '--no-check-certificate'
      ];

      if (isDev) {
        command.push('--verbose');
      }

      console.log('Starting Rclone API with command:', rcloneBinary, command.join(' '));

      const apiProcess = spawn(rcloneBinary, command, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      let isStarted = false;
      let checkInterval = null;
      let startupTimeout = null;

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
            console.log('API responding at:', Cache.apiEndpoint);
            clearInterval(checkInterval);
            clearTimeout(startupTimeout);
            resolve(true);
          }
        } catch (error) {
          console.error('API check error:', error);
        }
      };

      apiProcess.stdout.on('data', (data) => {
        console.log('Rclone API:', data.toString().trim());
      });

      apiProcess.stderr.on('data', (data) => {
        console.error('Rclone API Error:', data.toString().trim());
      });

      apiProcess.on('close', (code) => {
        console.log(`Rclone API process exited with code ${code}`);
        if (!isStarted) {
          clearInterval(checkInterval);
          clearTimeout(startupTimeout);
          resolve(false);
        }
      });

      setTimeout(() => {
        checkInterval = setInterval(waitForApi, 1000);
        
        startupTimeout = setTimeout(() => {
          if (!isStarted) {
            console.error('Rclone API startup timeout');
            clearInterval(checkInterval);
            if (apiProcess.pid) {
              try {
                process.kill(apiProcess.pid);
              } catch (err) {
                console.error('Error killing process:', err);
              }
            }
            resolve(false);
          }
        }, 15000);
      }, 2000);

    } catch (error) {
      console.error('Failed to start Rclone API:', error);
      resolve(false);
    }
  });
};

/**
 * Initialize caches
 */
const updateProvidersCache = async function() {
  try {
    const response = await makeRcloneRequest('POST', ApiUrls.providers);
    Cache.providers = {};
    
    Object.keys(response.providers).forEach(type => {
      if (!UnsupportedRcloneProviders.includes(type)) {
        Cache.providers[type] = {
          type,
          description: response.providers[type],
          requiresBucket: BucketRequiredProviders.includes(type)
        };
      }
    });
    
    if (isDev) {
      console.log('Updated providers cache:', Cache.providers);
    }
  } catch (error) {
    console.error('Failed to update providers cache:', error);
    throw new Error('Failed to get rclone providers');
  }
};

const updateBookmarksCache = async function() {
  try {
    const response = await makeRcloneRequest('POST', ApiUrls.configDump);
    Cache.bookmarks = {};

    Object.keys(response).forEach(name => {
      if (name !== 'RCLONE_ENCRYPT_V0') {
        const bookmark = response[name];
        bookmark.$name = name;
        Cache.bookmarks[name] = bookmark;
      }
    });

    if (isDev) {
      console.log('Updated bookmarks cache:', Cache.bookmarks);
    }
  } catch (error) {
    console.error('Failed to update bookmarks cache:', error);
    throw new Error('Failed to get rclone config');
  }
};

/**
 * Initialize rclone
 */
const init = async function() {
  try {
    if (process.platform === 'linux' || process.platform === 'darwin') {
      process.env.PATH += ':' + path.join('/', 'usr', 'local', 'bin');
    }

    const apiStarted = await startRcloneAPI();
    
    if (apiStarted) {
      console.log('Rclone API server started successfully');
      apiService = new RcloneApiService(settings.get('rclone_api_port'), 'user', 'pass');
      mountService = new RcloneMountService(apiService);
      syncService = new RcloneSyncService(apiService, {
        getSyncConfig: getSyncConfig,
        saveSyncConfig: saveSyncConfig
      });
      
      Cache.apiService = apiService;
      Cache.syncService = syncService;
    } else {
      console.log('Running in CLI mode');
    }

    const versionResponse = await makeRcloneRequest('POST', ApiUrls.version);
    Cache.version = versionResponse.version;
    console.log('Rclone version:', Cache.version);

    Cache.configFile = settings.get('rclone_config') || path.join(app.getPath('userData'), 'rclone.conf');
    console.log('Using config file:', Cache.configFile);

    await updateProvidersCache();
    await updateBookmarksCache();
    if (apiStarted) {
      await mountService.updateMountPointsCache();
    }

    console.log('Rclone initialized successfully');
    
  } catch (error) {
    console.error('Failed to initialize rclone:', error);
    throw error;
  }
};

/**
 * Cleanup before quit
 */
const prepareQuit = async function() {
  if (syncService) {
    await syncService.cleanup();
  }
  if (Cache.apiProcess) {
    Cache.apiProcess.kill();
    Cache.apiProcess = null;
    Cache.apiEndpoint = null;
  }
};

// Provider functions
const getProvider = function(type) {
  if (!(type in Cache.providers)) {
    throw new Error(`Provider ${type} not found`);
  }
  return Cache.providers[type];
};

const getProviders = function() {
  return Cache.providers;
};

// Bookmark functions
const getBookmark = function(id) {
  if (!(id in Cache.bookmarks)) {
    throw new Error(`Bookmark ${id} not found`);
  }
  return Cache.bookmarks[id];
};

const getBookmarks = function() {
  return Cache.bookmarks;
};
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
// Mount functions
const mount = async function(bookmark, mountName = 'default') {
  return mountService ? await mountService.mount(bookmark, mountName) : false;
};

const unmount = async function(bookmark, mountName = 'default') {
  return mountService ? await mountService.unmount(bookmark, mountName) : false;
};

const getMountStatus = function(bookmark, mountName = 'default') {
  return mountService ? mountService.getMountStatus(bookmark, mountName) : false;
};
const openMountPoint = async function(bookmark) {
  const mountPoint = getMountStatus(bookmark);
  if (mountPoint) {
      await shell.openPath(mountPoint);
      return true;
  }
  return false;
}

// Sync functions
const startSync = async function(bookmark, syncName) {
  return syncService ? await syncService.startSync(bookmark, syncName) : false;
};

const stopSync = async function(bookmark, syncName) {
  return syncService ? await syncService.stopSync(bookmark, syncName) : false;
};

const getSyncStatus = function(bookmark, syncName) {
  return syncService ? syncService.getSyncStatus(bookmark, syncName) : false;
};

// Helper functions
const onUpdate = function(callback) {
  UpdateCallbacksRegistry.push(callback);
};

const getVersion = function() {
  return Cache.version;
};

// Module exports (maintaining backward compatibility)
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
  getMountConfig: mountService ? mountService.getMountConfig.bind(mountService) : null,
  getMountPath: mountService ? mountService.getMountPath.bind(mountService) : null,
  createMountConfig: mountService ? mountService.createMountConfig.bind(mountService) : null,
  deleteMountConfig: mountService ? mountService.deleteMountConfig.bind(mountService) : null,
  getMountOptionSets: mountService ? mountService.getMountOptionSets.bind(mountService) : null,
  saveMountConfig: mountService ? mountService.saveMountConfig.bind(mountService) : null,
  
  // Sync functions
  getSyncOptionSets,
  getSyncConfig,
  saveSyncConfig,
  startSync,
  stopSync,
  getSyncStatus,
  
  // Helper functions
  getVersion,
  onUpdate,
  
  // Constants for backward compatibility
  DEFAULT_MOUNT_OPTIONS,
  DEFAULT_SYNC_OPTIONS,
  
  // Debug exports
  Cache: isDev ? Cache : undefined
};