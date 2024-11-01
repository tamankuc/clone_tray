const { app } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');

const UnsupportedRcloneProviders = [
  'union',
  'crypt'
];

const BucketRequiredProviders = [
  'b2',
  'swift', 
  's3',
  'gsc',
  'hubic'
];

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
};

const DEFAULT_MOUNT_OPTIONS = {
  '_rclonetray_mount_enabled': false,
  '_rclonetray_mount_path': '',
  '_rclonetray_mount_options': {
    '--vfs-cache-mode': 'writes',
    '--dir-cache-time': '30m',
    '--vfs-cache-max-age': '24h',
    '--vfs-read-ahead': '128M',
    '--buffer-size': '32M'
  }
};

const DEFAULT_SYNC_OPTIONS = {
  '_rclonetray_sync_enabled': false,
  '_rclonetray_sync_local_path': '',
  '_rclonetray_sync_remote_path': '',
  '_rclonetray_sync_mode': 'bisync',
  '_rclonetray_sync_direction': 'upload'
};

const RcloneBinaryName = process.platform === 'win32' ? 'rclone.exe' : 'rclone';

const RcloneBinaryBundled = app.isPackaged
  ? path.join(process.resourcesPath, 'rclone', process.platform, RcloneBinaryName)
  : path.join(app.getAppPath(), 'rclone', process.platform, RcloneBinaryName);

module.exports = {
  UnsupportedRcloneProviders,
  BucketRequiredProviders,
  ApiUrls,
  DEFAULT_MOUNT_OPTIONS,
  DEFAULT_SYNC_OPTIONS,
  RcloneBinaryName,
  RcloneBinaryBundled,
  isDev
};