'use strict'

const path = require('path')
const fs = require('fs')
const { app } = require('electron')

/**
 * Path to settings.json file
 * @private
 */
const settingsFile = path.join(app.getPath('userData'), 'settings.json')



const defaultConfigPath = '/Users/vladislavkupriianov/.config/rclone'

/**
 * Cache for current settings and predefine defaults.
 * @private
 */
const cache = {
  tray_menu_show_type: true,
  rclone_use_bundled: true,
  rclone_config: path.join(app.getPath('home'), '.config', 'rclone', 'rclone.conf'),
  rclone_log_path: path.join(app.getPath('home'), '.config', 'rclone', 'rclone.log'),
  log_app_path: path.join(app.getPath('home'), '.config', 'rclone', 'app.log'),
  custom_args: '',
  rclone_api_enable: true,
  rclone_api_port: 5572,
  rclone_api_auth_enable: 1,
  rclone_api_username: 'user',
  rclone_api_password: 'pass',
  rclone_cache_files: 3,
  rclone_cache_directories: 10,
  rclone_sync_enable: true,
  rclone_sync_autoupload_delay: 5,
  rclone_ncdu_enable: false,
  rclone_serving_http_enable: false,
  rclone_serving_ftp_enable: false,
  rclone_serving_restic_enable: false,
  rclone_serving_webdav_enable: false,
  rclone_serving_username: 'user',
  rclone_serving_password: 'pass',
  rclone_rc_allow_origin: '*',
  rclone_rc_no_auth: true,
}

/**
 * Check if setting exists
 * @param {string} item
 * @returns {boolean}
 */
const has = function (item) {
  // console.log('Checking if setting exists:', item);
  // console.log('Current cache:', cache);
  // console.log('Cache has item:', cache.hasOwnProperty(item));
  return cache.hasOwnProperty(item)
}

/**
 * Get setting value
 * @param {string} item
 * @param {*} defaultValue
 * @returns {*}
 */
const get = function (item, defaultValue) {
  console.log(settingsFile)

  // console.log('Getting setting:', item);
  // console.log('Current cache value:', cache[item]);
  // console.log('Default value:', defaultValue);
  return has(item) ? cache[item] : defaultValue;
}

/**
 * Set setting value
 * @param {string} item
 * @param {*} newValue
 */
const set = function (item, newValue) {
  cache[item] = newValue
  updateFile()
}

/**
 * Remove setting
 * @param {string} item
 * @returns {boolean}
 */
const remove = function (item) {
  if (has(item)) {
    delete cache[item]
    updateFile()
    return true
  }

  return false
}

/**
 * Merge current settings
 * @param {{}} settingsObject
 */
const merge = function (settings) {
  Object.keys(settings).forEach(function (key) {
    cache[key] = settings[key]
    if (key === 'rclone_config') {
      cache[key] = path.join(app.getPath('home'), '.config', 'rclone', 'rclone.conf')
    }
  })
  updateFile()
}

/**
 * Get all settings
 * @returns {{}}
 */
const getAll = function () {
  return cache
}

/**
 * Update the settings file.
 */
const updateFile = function () {
  try {
    let jsonContent = JSON.stringify(cache)
    fs.writeFileSync(settingsFile, jsonContent)
  } catch (err) {
    console.error('Settings', err)
  }
}

/**
 * Read the settings file and init the settings cache.
 */
const readFile = function () {
  // Create the directory if not exists yet.
  if (!fs.existsSync(app.getPath('userData'))) {
    fs.mkdirSync(app.getPath('userData'))
  }

  // Initialize settings cache.
  if (fs.existsSync(settingsFile)) {
    try {
      let settings = JSON.parse(fs.readFileSync(settingsFile))
      Object.keys(settings).forEach(function (key) {
        cache[key] = settings[key]
      })
    } catch (err) {
      console.error('Settings', err)
    }
  }
}

// Read the settings file and init the settings cache.
readFile()

// Exports.
// Because next keywords are very common and delete has an collision,
// should pick more odd names or do some longnames.
module.exports = {
  set,
  get,
  has,
  getAll,
  remove,
  merge
}
