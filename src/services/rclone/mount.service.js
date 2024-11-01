const fs = require('fs');
const path = require('path');
const ini = require('ini');
const dialogs = require('../../dialogs');
const Cache = require('./cache');
const { DEFAULT_MOUNT_OPTIONS } = require('./constants');

class RcloneMountService {
  constructor(apiService) {
    this.apiService = apiService;
  }

  getMountCacheKey(bookmarkName, mountName = 'default') {
    return `${bookmarkName}@@${mountName}`;
  }

  getMountPath(bookmark, mountName = 'default') {
    const config = this.getMountConfig(bookmark, mountName);
    if (config.path) {
      return config.path;
    }
    
    const mountDir = path.join(app.getPath('temp'), 'rclonetray-mounts');
    if (!fs.existsSync(mountDir)) {
      fs.mkdirSync(mountDir, { recursive: true });
    }
    
    return mountName === 'default' ? 
      path.join(mountDir, bookmark.$name) :
      path.join(mountDir, `${bookmark.$name}@@${mountName}`);
  }

  getMountConfig(bookmark, mountName = 'default') {
    const config = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
    const sectionKey = mountName === 'default' ? bookmark.$name : `${bookmark.$name}.mount_${mountName}`;
    
    const mountConfig = {
      enabled: false,
      path: '',
      remotePath: '',
      options: { ...DEFAULT_MOUNT_OPTIONS._rclonetray_mount_options }
    };

    if (config[sectionKey]) {
      if ('_rclonetray_remote_path' in config[sectionKey]) {
        mountConfig.remotePath = config[sectionKey]._rclonetray_remote_path;
      }

      if ('_rclonetray_mount_enabled' in config[sectionKey]) {
        mountConfig.enabled = config[sectionKey]._rclonetray_mount_enabled === 'true';
      }

      if ('_rclonetray_mount_path' in config[sectionKey]) {
        mountConfig.path = config[sectionKey]._rclonetray_mount_path;
      }

      Object.keys(config[sectionKey]).forEach(key => {
        if (key.startsWith('_rclonetray_mount_opt_')) {
          const optionName = '--' + key.replace('_rclonetray_mount_opt_', '');
          mountConfig.options[optionName] = config[sectionKey][key];
        }
      });
    }

    return mountConfig;
  }

  async mount(bookmark, mountName = 'default') {
    try {
      const config = this.getMountConfig(bookmark, mountName);
      const mountPoint = this.getMountPath(bookmark, mountName);
      const cacheKey = this.getMountCacheKey(bookmark.$name, mountName);
      
      if (Cache.mountPoints[cacheKey]) {
        console.log('Already mounted:', bookmark.$name, mountName);
        return true;
      }

      if (!fs.existsSync(mountPoint)) {
        fs.mkdirSync(mountPoint, { recursive: true });
      }

      const remoteName = bookmark.$name + ':';
      const remotePath = config.remotePath ? 
        path.posix.join(remoteName, config.remotePath) : 
        remoteName;

      console.log('Mounting', remotePath, 'to', mountPoint, 'with options:', config.options);

      const mountParams = {
        fs: remotePath,
        mountPoint: mountPoint,
        mountOpt: config.options
      };

      await this.apiService.createMount(mountParams);
      
      Cache.mountPoints[cacheKey] = {
        path: mountPoint,
        remote: remotePath,
        options: config.options
      };

      config.enabled = true;
      this.saveMountConfig(bookmark, config, mountName);

      return true;
    } catch (error) {
      console.error('Mount error:', error);
      dialogs.rcloneAPIError(`Failed to mount ${bookmark.$name}: ${error.message}`);
      return false;
    }
  }

  async unmount(bookmark, mountName = 'default') {
    try {
      const cacheKey = this.getMountCacheKey(bookmark.$name, mountName);
      
      if (!Cache.mountPoints[cacheKey]) {
        console.log('Not mounted:', bookmark.$name, mountName);
        return true;
      }

      const mountPoint = Cache.mountPoints[cacheKey].path;
      console.log('Unmounting', mountPoint);

      await this.apiService.unmount(mountPoint);
      
      delete Cache.mountPoints[cacheKey];

      const config = this.getMountConfig(bookmark, mountName);
      config.enabled = false;
      this.saveMountConfig(bookmark, config, mountName);

      return true;
    } catch (error) {
      console.error('Unmount error:', error);
      dialogs.rcloneAPIError(`Failed to unmount ${bookmark.$name}: ${error.message}`);
      return false;
    }
  }

  saveMountConfig(bookmark, config, mountName = 'default') {
    const rcloneConfig = ini.parse(fs.readFileSync(Cache.configFile, 'utf-8'));
    const sectionKey = mountName === 'default' ? bookmark.$name : `${bookmark.$name}.mount_${mountName}`;

    if (!rcloneConfig[sectionKey]) {
      rcloneConfig[sectionKey] = {};
    }

    if (config.remotePath) {
      rcloneConfig[sectionKey]._rclonetray_remote_path = config.remotePath;
    }

    rcloneConfig[sectionKey]._rclonetray_mount_enabled = config.enabled.toString();
    
    if (config.path) {
      rcloneConfig[sectionKey]._rclonetray_mount_path = config.path;
    }

    Object.entries(config.options || {}).forEach(([key, value]) => {
      rcloneConfig[sectionKey][`_rclonetray_mount_opt_${key.replace('--', '')}`] = value;
    });

    fs.writeFileSync(Cache.configFile, ini.stringify(rcloneConfig));
  }
}

module.exports = RcloneMountService;