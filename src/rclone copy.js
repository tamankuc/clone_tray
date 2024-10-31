'use strict'

const { exec, execSync, spawn } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const chokidar = require('chokidar')
const ini = require('ini')
const { app, shell } = require('electron')
const isDev = require('electron-is-dev')
const settings = require('./settings')
const dialogs = require('./dialogs')
const fetch = require('node-fetch');

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
  // When packed, the rclone is placed under the resource directory.
  ? path.join(process.resourcesPath, 'rclone', process.platform, RcloneBinaryName)
  // When unpacked and in dev, rclone directory is whithin the app directory.
  : path.join(app.getAppPath(), 'rclone', process.platform, RcloneBinaryName)

/**
 * System's temp directory
 * @private
 */
const tempDir = app.getPath('temp')

/**
 * Rclone settings cache
 * @private
 */
const Cache = {
  version: null,
  configFile: '',
  providers: {},
  bookmarks: {},
  rcloneServer: null
}

/**
 * @private
 */
const UpdateCallbacksRegistry = []

/**
 * BookmarkProcessManager registry
 * @private
 */
const BookmarkProcessRegistry = {}

/**
 * Automatic Upload for bookmark registry
 * @private
 */
const AutomaticUploadRegistry = {}
const getConfigFile = function () {
  return Cache.configFile
}

/**
 * Enquote command
 * @param {Array} command
 */
const enquoteCommand = function (command) {
  for (let i in command) {
    if (command[i].substr(0, 2) !== '--') {
      command[i] = JSON.stringify(command[i])
    }
  }
  return command
}

/**
 * Prepare array to Rclone command, rclone binary should be ommited
 * @param {array} command
 * @returns {string|array}
 * @private
 */
const prepareRcloneCommand = function (command) {
  let config = getConfigFile()
  if (config) {
    command.unshift('--config', config)
  }

  if (settings.get('rclone_use_bundled')) {
    command.unshift(RcloneBinaryBundled)
  } else {
    command.unshift(RcloneBinaryName)
  }

  command.push('--auto-confirm')

  return command
}

/**
 * Append custom rclone args to command array
 * @param {Array} commandArray
 * @param {string} bookmarkName
 * @returns {Array}
 */
const appendCustomRcloneCommandArgs = function (commandArray, bookmarkName) {
  // @private
  const verboseCommandStrPattern = new RegExp(/^-v+\b/)
  const filterCustomArgsVerbose = function (arg) {
    if (verboseCommandStrPattern.test(arg)) {
      return false
    }
  }

  const argsSplitterPattern = new RegExp(/\n+/)

  let customGlobalArgs = settings.get('custom_args').trim().split(argsSplitterPattern)
  customGlobalArgs = customGlobalArgs.filter(filterCustomArgsVerbose)
  commandArray = commandArray.concat(customGlobalArgs)

  if (bookmarkName) {
    let bookmark = getBookmark(bookmarkName)
    if ('_rclonetray_custom_args' in bookmark && bookmark._rclonetray_custom_args.trim()) {
      let customBookmarkArgs = bookmark._rclonetray_custom_args.trim().split(argsSplitterPattern)
      customBookmarkArgs = customBookmarkArgs.filter(filterCustomArgsVerbose)
      commandArray = commandArray.concat(customBookmarkArgs)
    }
  }

  // Remove empties.
  return commandArray.filter(function (element) {
    return !!element.trim()
  })
}

/**
 * Execute async Rclone command
 * @param command
 * @returns {Promise}
 * @private
 */
const doCommand = async function (command) {
  try {
    const response = await makeRcloneRequest('POST', '/core/command', {
      command: command.join(' ')
    });
    return response.result;
  } catch (error) {
    console.error('Rclone command failed:', error);
    throw error;
  }
}

/**
 * Execute synchronious Rclone command and return the output
 * @param command
 * @returns {string}
 * @private
 * @throws {err}
 */
const doCommandSync = function (args) {
  try {
    const preparedCommand = prepareRcloneCommand(args);
    return execSync(preparedCommand.join(' ')).toString();
  } catch (error) {
    console.error('Rclone sync command failed:', error);
    throw error;
  }
}

/**
 *
 * @param {*} command
 */
const doCommandInTerminal = function (command) {
  command = enquoteCommand(command)
  command = command.join(' ')

  if (isDev) {
    console.log('Rclone[T]', command)
  }

  if (process.platform === 'darwin') {
    // macOS's Terminal
    command = command.replace(new RegExp('"', 'g'), '\\"')
    spawn('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "${command}" activate`])
  } else if (process.platform === 'linux') {
    // Linux terminal
    let tempCmdWrapper = path.join(tempDir, 'rclonetray-linux-cmd-wrapper.sh')
    const data = new Uint8Array(Buffer.from(command))
    fs.writeFile(tempCmdWrapper, data, function (err) {
      if (err) {
        throw Error('Cannot open terminal')
      } else {
        fs.chmodSync(tempCmdWrapper, 0o755)
        exec(`x-terminal-emulator -e "${tempCmdWrapper}"`)
      }
    })
  } else if (process.platform === 'win32') {
    // Windows cmd
    exec(`start cmd.exe /K "${command}"`)
  }
}

/**
 * Simple process tracker. Used to track the rclone command processes status and output.
 */
class BookmarkProcessManager {
  /**
   * Constructor
   * @param {*} processName
   * @param {*} bookmarkName
   */
  constructor (processName, bookmarkName) {
    this.id = `${bookmarkName}:${processName}`
    this.bookmarkName = bookmarkName
    this.processName = processName
  };

  /**
   * Create new monitored process
   * @param {Array} command
   */
  create (command) {
    try {
      if (!command || command.length < 0) {
        throw Error('Broken Rclone command')
      }
      if (this.exists()) {
        console.error(`Trying to create new ${this.processName} over existing for ${this.bookmarkName}.`)
        throw Error('There is already such process.')
      }
      let id = this.id

      command = prepareRcloneCommand(command)
      command = appendCustomRcloneCommandArgs(command, this.bookmarkName)

      BookmarkProcessRegistry[id] = {
        bookmarkName: this.bookmarkName,
        processName: this.processName,
        process: spawn(command[0], command.slice(1)),
        data: {
          OK: false
        }
      }

      if (isDev) {
        console.log('Rclone[BP]', command)
      }

      BookmarkProcessRegistry[id].process.stderr.on('data', this.rcloneProcessWatchdog.bind(this))
      BookmarkProcessRegistry[id].process.on('error', (err) => {
        console.error('Process error:', err)
        this.kill()
      })

      BookmarkProcessRegistry[id].process.on('close', function () {
        if (BookmarkProcessRegistry[id].data.OK) {
          if (BookmarkProcessRegistry[id].processName === 'download') {
            dialogs.notification(`Downloading from ${BookmarkProcessRegistry[id].bookmarkName} is finished`)
          } else if (BookmarkProcessRegistry[id].processName === 'upload') {
            dialogs.notification(`Uploading to ${BookmarkProcessRegistry[id].bookmarkName} is finished`)
          } else if (BookmarkProcessRegistry[id].processName === 'mount') {
            dialogs.notification(`Unmounted ${BookmarkProcessRegistry[id].bookmarkName}`)
          } else if (BookmarkProcessRegistry[id].processName.startsWith('serve_')) {
            let servingProtocolName = getAvailableServeProtocols()[BookmarkProcessRegistry[id].data.protocol]
            dialogs.notification(`${servingProtocolName} server for ${BookmarkProcessRegistry[id].bookmarkName} is stopped`)
          }
        }
        delete BookmarkProcessRegistry[id]
        fireRcloneUpdateActions()
      })
    } catch (err) {
      console.error('Error creating process:', err)
      throw err
    }
  }

  /**
   * Get the process
   * @returns {childProcess}
   */
  getProcess () {
    return BookmarkProcessRegistry[this.id].process
  }

  /**
   * Set meta data
   * @param {string} key
   * @param {*} value
   */
  set (key, value) {
    if (this.exists()) {
      BookmarkProcessRegistry[this.id].data[key] = value
      return true
    } else {
      return false
    }
  }

  /**
   * Get meta data
   * @param {*} key
   * @returns {*}
   */
  get (key) {
    return BookmarkProcessRegistry[this.id].data[key]
  }

  /**
   * Check if process is existing and running
   * @returns bool
   */
  exists () {
    return BookmarkProcessRegistry.hasOwnProperty(this.id)
  }

  /**
   * Kill the process wit signal
   * @param {string} signal
   */
  kill (signal) {
    if (this.exists()) {
      BookmarkProcessRegistry[this.id].process.kill(signal || 'SIGTERM')
    } else {
      throw Error('No such process')
    }
  }

  /**
   * Kill all processes for given bookmark
   * @param {string} bookmarkName
   */
  static killAll (bookmarkName) {
    Object.values(BookmarkProcessRegistry).forEach(function (item) {
      if (!bookmarkName || item.bookmarkName === bookmarkName) {
        item.process.kill()
      }
    })
  }

  /**
   * Get count of active processes
   * @returns {Number}
   */
  static getActiveProcessesCount () {
    return Object.values(BookmarkProcessRegistry).length
  }

  /**
   * @TODO make better log catcher
   *
   * Process rclone output line and do action
   * @param {string} logLine
   * @param {{}} bookmark
   * @param {BookmarkProcessManager} bookmarkProcess
   */
  rcloneProcessWatchdogLine (logLine) {
    // Prepare lineInfo{time,level,message}
    let lineInfo = {}

    // Time is Y/m/d H:i:s
    lineInfo.time = logLine.substr(0, 19)

    // Level could be ERROR, NOTICE, INFO or DEBUG.
    logLine = logLine.substr(19).trim().split(':')
    lineInfo.level = (logLine[0] || '').toString().toUpperCase().trim()

    if (['ERROR', 'NOTICE', 'INFO', 'DEBUG'].indexOf(lineInfo.level) === -1) {
      lineInfo.level = 'UNKNOWN'
      lineInfo.message = logLine.join(':').trim()
    } else {
      // String message
      lineInfo.message = logLine.slice(1).join(':').trim()
    }

    // Just refresh when:
    if (/rclone.*finishing/i.test(lineInfo.message)) {
      fireRcloneUpdateActions()
      return
    }

    // Catch errors in the output, so need to kill the process and refresh
    if (/(Error while|Failed to|Fatal Error|coudn't connect)/i.test(lineInfo.message)) {
      dialogs.notification(lineInfo.message)
      BookmarkProcessRegistry[this.id].process.kill()
      fireRcloneUpdateActions()
      return
    }

    // When remote is mounted.
    if (/Mounting on "/.test(lineInfo.message)) {
      dialogs.notification(`Mounted ${this.bookmarkName}`)
      fireRcloneUpdateActions()
      this.set('OK', true)
      return
    }

    // When serving address is already binded.
    let addressInUse = lineInfo.message.match(/Opening listener.*address already in use/i)
    if (addressInUse) {
      dialogs.notification(addressInUse[0])
      BookmarkProcessRegistry[this.id].process.kill()
      fireRcloneUpdateActions()
      return
    }

    // Serving is started.
    let matchingString = lineInfo.message.match(/(Serving FTP on|Serving on|Server started on|Serving restic REST API on)\s*(.*)$/i)
    if (matchingString && matchingString[2]) {
      dialogs.notification(matchingString[0])
      this.set('OK', true)
      if (matchingString[1] === 'Serving FTP on') {
        this.set('URI', 'ftp://' + matchingString[2])
      } else {
        this.set('URI', matchingString[2])
      }
      fireRcloneUpdateActions()
      return
    }

    if (isDev) {
      console.log('Rclone Watchdog', lineInfo)
    }
  }

  /**
   * Helper function that split stream to lines and send to rcloneProcessWatchdogLine for processing
   * @param {{}} bookmark
   * @param {{}} data
   */
  rcloneProcessWatchdog (data) {
    // https://stackoverflow.com/a/30136877
    let acc = ''
    let splitted = data.toString().split(/\r?\n/)
    let inTactLines = splitted.slice(0, splitted.length - 1)
    // if there was a partial, unended line in the previous dump, it is completed by the first section.
    inTactLines[0] = acc + inTactLines[0]
    // if there is a partial, unended line in this dump,
    // store it to be completed by the next (we assume there will be a terminating newline at some point.
    // This is, generally, a safe assumption.)
    acc = splitted[splitted.length - 1]
    for (var i = 0; i < inTactLines.length; ++i) {
      this.rcloneProcessWatchdogLine(inTactLines[i].trim())
    }
  }
}

/**
 * Get current config file location
 * @returns {string}
 */

/**
 * Update version cache
 * @private
 */
const updateVersionCache = async function () {
  try {
    let output = await doCommandSync(['version']);
    let version = output.trim().split(/\r?\n/).shift().split(/\s+/).pop() || 'Unknown';
    if (Cache.version && Cache.version !== version) {
      // rclone binary is upgraded
    }
    Cache.version = version;
  } catch (error) {
    console.error('Failed to update version cache:', error);
    Cache.version = 'Unknown';
  }
}

/**
 * Update bookmarks cache
 * @private
 */
const updateBookmarksCache = async function () {
  try {
    // Check if config file exists
    const configFile = getConfigFile();
    if (!configFile || !fs.existsSync(configFile)) {
      // No config file yet, initialize empty bookmarks
      Cache.bookmarks = {};
      fireRcloneUpdateActions();
      return;
    }

    const bookmarks = await doCommand(['config', 'dump']);
    Cache.bookmarks = {};
    
    try {
      const parsed = JSON.parse(bookmarks);
      
      // Add virtual $name representing the bookmark name from index
      Object.keys(parsed).forEach(function (key) {
        if (UnsupportedRcloneProviders.indexOf(parsed[key].type) !== -1) {
          return;
        }
        Cache.bookmarks[key] = parsed[key];
        Cache.bookmarks[key].$name = key;
      });
    } catch (err) {
      console.error('Failed to parse bookmarks:', err);
      Cache.bookmarks = {}; // Reset to empty on error
    }
    
    fireRcloneUpdateActions();
  } catch (err) {
    console.error('Failed to read bookmarks:', err);
    Cache.bookmarks = {}; // Reset to empty on error
    fireRcloneUpdateActions();
  }
};

/**
 * Update providers cache, add $type options objects
 * @private
 */
const updateProvidersCache = function () {
  // Hardcoded providers for local and webdav only
  const providers = [
    {
      Prefix: "local",
      Name: "Local Disk",
      Description: "Local disk storage",
      Options: [
        {
          Name: "_rclonetray_local_path_map",
          Help: "Local path mapping",
          Provider: "",
          Default: "",
          Value: null,
          ShortOpt: "",
          Hide: 0,
          Required: false,
          IsPassword: false,
          NoPrefix: false,
          Advanced: false
        }
      ]
    },
    {
      Prefix: "webdav",
      Name: "WebDAV",
      Description: "WebDAV storage",
      Options: [
        {
          Name: "url",
          Help: "URL of WebDAV server",
          Provider: "",
          Default: "",
          Value: null,
          Required: true,
          IsPassword: false
        },
        {
          Name: "user",
          Help: "WebDAV username",
          Provider: "",
          Default: "",
          Value: null,
          Required: false,
          IsPassword: false
        },
        {
          Name: "pass",
          Help: "WebDAV password",
          Provider: "",
          Default: "",
          Value: null,
          Required: false,
          IsPassword: true
        },
        {
          Name: "_rclonetray_local_path_map",
          Help: "Local path mapping",
          Provider: "",
          Default: "",
          Value: null,
          Required: false,
          IsPassword: false,
          Advanced: true
        }
      ]
    }
  ];

  Cache.providers = {};
  providers.forEach(function (provider) {
    if (UnsupportedRcloneProviders.indexOf(provider.Prefix) === -1) {
      Cache.providers[provider.Prefix] = provider;
    }
  });

  fireRcloneUpdateActions();
};

/**
 * Trigger for register update cache listeners
 * @param eventName
 * @private
 */
const fireRcloneUpdateActions = function (eventName) {
  UpdateCallbacksRegistry.forEach(function (callback) {
    callback(eventName)
  })
}

/**
 * Perform Rclone sync command, this function is used as shared for Download and Upload tasks
 * @private
 * @param {string} method
 * @param {{}} bookmark
 * @throws {Error}
 */
const sync = function (method, bookmark) {
  // Check supported method
  if (method !== 'upload' && method !== 'download') {
    throw Error(`Unsupported sync method ${method}`)
  }

  // Check if have set local path mapping.
  if (!('_rclonetray_local_path_map' in bookmark && bookmark._rclonetray_local_path_map)) {
    console.error('Rclone', 'Sync', 'Local Path Map is not set for this bookmark', bookmark)
    throw Error('Local Path Map is not set for this bookmark')
  }

  // Do not allow syncing from root / or X:\, they are dangerous and can lead to damages.
  // If you are so powered user, then do it from the cli.
  let localPathMapParsed = path.parse(bookmark._rclonetray_local_path_map)
  if (!localPathMapParsed.dir) {
    console.error('Rclone', 'Sync', 'Trying to sync from/to root', bookmark)
    throw Error('Operations with root drive are not permited because are dangerous, set more inner directory for bookmark directory mapping or use cli for this purpose.')
  }

  let cmd = ['sync']
  if (method === 'upload') {
    cmd.push(bookmark._rclonetray_local_path_map, getBookmarkRemoteWithRoot(bookmark))
  } else {
    cmd.push(getBookmarkRemoteWithRoot(bookmark), bookmark._rclonetray_local_path_map)
  }
  cmd.push('-vv')

  // Check if source directory is empty because this could damage remote one.
  if (method === 'upload') {
    if (!fs.readdirSync(bookmark._rclonetray_local_path_map).length) {
      throw Error('Cannot upload empty directory.')
    }
  }

  let oppositeMethod = method === 'download' ? 'upload' : 'download'

  if ((new BookmarkProcessManager(oppositeMethod, bookmark.$name)).exists()) {
    throw Error(`Cannot perform downloading and uploading in same time.`)
  }

  let proc = new BookmarkProcessManager(method, bookmark.$name)
  proc.create(cmd)
  proc.set('OK', true)
  fireRcloneUpdateActions()
}

/**
 * Get bookmark
 * @param {{}|string} bookmark
 * @returns {{}}
 * @throws {Error}
 */
const getBookmark = function (bookmark) {
  if (typeof bookmark === 'object') {
    return bookmark
  } else if (bookmark in Cache.bookmarks) {
    return Cache.bookmarks[bookmark]
  } else {
    throw Error(`No such bookmark ${bookmark}`)
  }
}

/**
 * Add callback to execute when Rclone config is changed.
 * @param callback
 */
const onUpdate = function (callback) {
  UpdateCallbacksRegistry.push(callback)
}

/**
 * Get available providers
 * @returns {Cache.providers|{}}
 */
const getProviders = function () {
  return Cache.providers
}

/**
 * Get specific provider
 * @param providerName
 * @returns {{}}
 * @throws {Error}
 */
const getProvider = function (providerName) {
  if (Cache.providers.hasOwnProperty(providerName)) {
    return Cache.providers[providerName]
  } else {
    throw Error(`No such provider ${providerName}`)
  }
}

/**
 * Get bookmarks
 * @returns {Cache.bookmarks}
 */
const getBookmarks = function () {
  return Cache.bookmarks
}

/**
 * Check if bookmark options are valid
 * @param {*} providerObject
 * @param {*} values
 * @return Error|null
 */
const validateBookmarkOptions = function (providerObject, values) {
  providerObject.Options.forEach(function (optionDefinition) {
    let fieldName = optionDefinition.$Label || optionDefinition.Name
    if (optionDefinition.Required && (!values.hasOwnProperty(optionDefinition.Name) || !values[optionDefinition.Name])) {
      throw Error(`${fieldName} field is required`)
    }
    // @TODO type checks
  })
}

/**
 * Update existing bookmark's fields (rclone remote optons)
 * @param {string} bookmarkName
 * @param {{}} providerObject
 * @param {{}} values
 * @throws {Error}
 */
const updateBookmarkFields = function (bookmarkName, providerObject, values, oldValues) {
  let valuesPlain = {}

  providerObject.Options.forEach(function (optionDefinition) {
    if (optionDefinition.$Type === 'password') {
      if (!oldValues || oldValues[optionDefinition.Name] !== values[optionDefinition.Name]) {
        doCommandSync(['config', 'password', bookmarkName, optionDefinition.Name, values[optionDefinition.Name]])
      }
    } else {
      // Sanitize booleans.
      if (optionDefinition.$Type === 'boolean') {
        if (optionDefinition.Name in values && ['true', 'yes', true, 1].indexOf(values[optionDefinition.Name]) > -1) {
          values[optionDefinition.Name] = 'true'
        } else {
          values[optionDefinition.Name] = 'false'
        }
      }
      valuesPlain[optionDefinition.Name] = values[optionDefinition.Name]
    }
  })

  try {
    let configIniStruct = ini.decode(fs.readFileSync(getConfigFile()).toString())
    configIniStruct[bookmarkName] = Object.assign(configIniStruct[bookmarkName], valuesPlain)
    fs.writeFileSync(getConfigFile(), ini.encode(configIniStruct, {
      whitespace: true
    }))
  } catch (err) {
    console.error(err)
    throw Error('Cannot update bookmark fields.')
  }
  console.log('Rclone', 'Updated bookmark', bookmarkName)
}

/**
 * Create new bookmark
 * @param {string} type
 * @param {string} bookmarkName
 * @param {{}} values
 * @returns {Promise}
 */
const addBookmark = function (type, bookmarkName, values) {
  // Will throw an error if no such provider exists.
  let providerObject = getProvider(type)
  let configFile = getConfigFile()

  return new Promise(function (resolve, reject) {
    if (!/^([a-zA-Z0-9\-_]{1,32})$/.test(bookmarkName)) {
      reject(Error(`Invalid name.\nName should be 1-32 chars long, and should contain only letters, gidits - and _`))
      return
    }

    // Validate values.
    validateBookmarkOptions(providerObject, values)

    if (Cache.bookmarks.hasOwnProperty(bookmarkName)) {
      reject(Error(`There "${bookmarkName}" bookmark already`))
      return
    }
    try {
      let iniBlock = `\n[${bookmarkName}]\nconfig_automatic = no\ntype = ${type}\n`
      fs.appendFileSync(configFile, iniBlock)
      console.log('Rclone', 'Creating new bookmark', bookmarkName)
      try {
        updateBookmarkFields(bookmarkName, providerObject, values)
        dialogs.notification(`Bookmark ${bookmarkName} is created`)
        resolve()
        // Done.
      } catch (err) {
        console.error('Rclone', 'Reverting bookmark because of a problem', bookmarkName, err)
        doCommand(['config', 'delete', bookmarkName])
          .then(function () {
            reject(Error('Cannot write bookmark options to config.'))
          })
          .catch(reject)
      }
    } catch (err) {
      console.error(err)
      reject(Error('Cannot create new bookmark'))
    }
  })
}

/**
 * Update existing bookmark
 * @param {{}|string} bookmark
 * @param {{}} values
 * @returns {Promise}
 */
const updateBookmark = function (bookmark, values) {
  bookmark = getBookmark(bookmark)
  let providerObject = getProvider(bookmark.type)
  return new Promise(function (resolve, reject) {
    // Validate values.
    validateBookmarkOptions(providerObject, values)

    try {
      updateBookmarkFields(bookmark.$name, providerObject, values, bookmark)
      dialogs.notification(`Bookmark ${bookmark.$name} is updated.`)
      resolve()
    } catch (err) {
      reject(err)
    }
  })
}
/**
 * Delete existing bookmark
 * @param {{}|string} bookmark
 * @returns {Promise}
 */
const deleteBookmark = function (bookmark) {
  bookmark = getBookmark(bookmark)
  return new Promise(function (resolve, reject) {
    doCommand(['config', 'delete', bookmark.$name])
      .then(function () {
        BookmarkProcessManager.killAll(bookmark.$name)
        dialogs.notification(`Bookmark ${bookmark.$name} is deleted.`)
        resolve()
      })
      .catch(reject)
  })
}

/**
 * Get bookmark remote with root
 * @param {{}} bookmark
 * @returns {string}
 */
const getBookmarkRemoteWithRoot = function (bookmark) {
  return bookmark.$name + ':' + (bookmark._rclonetray_remote_path || '/')
}

/**
 * Free directory that we use for mountpoints
 * @param {String} directoryPath
 * @returns {Boolean}
 */
const freeMountpointDirectory = function (directoryPath) {
  if (fs.existsSync(directoryPath)) {
    fs.readdir(directoryPath, function (err, files) {
      if (err) {
        throw err
      }
      if (!files.length) {
        fs.rmdirSync(directoryPath)
      }
    })
  }
  return true
}

/**
 * On windows find free drive letter.
 * @returns {string}
 */
const win32GetFreeLetter = function () {
  // First letters are reserved, floppy, system drives etc.
  const allLetters = ['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']
  let usedDriveLetters = execSync('wmic logicaldisk get name')
  usedDriveLetters = usedDriveLetters.toString()
    .split(/\n/)
    .map(function (line) {
      let letter = line.trim().match(/^([A-Z]):/)
      if (letter) {
        return letter[1]
      }
      return null
    })
    .filter(function (letter) {
      return !!letter
    })

  let freeLetter = allLetters.find(function (letter) {
    return usedDriveLetters.indexOf(letter) === -1
  })

  if (!freeLetter) {
    throw Error('Not available free drive letter')
  }

  return freeLetter + ':'
}

/**
 * Mount given bookmark
 * @param {{}|string} bookmark
 */
const mount = function (bookmark) {
  bookmark = getBookmark(bookmark)
  let proc = new BookmarkProcessManager('mount', bookmark.$name)

  if (proc.exists()) {
    throw Error(`Bookmark ${bookmark.$name} already mounted.`)
  }

  let mountpoint
  if (process.platform === 'win32') {
    mountpoint = win32GetFreeLetter()
  } else if (process.platform === 'linux') {
    mountpoint = path.join(os.homedir(), `mount.${bookmark.type}.${bookmark.$name}`)
  } else {
    mountpoint = path.join('/', 'Volumes', `${bookmark.type}.${bookmark.$name}`)
  }

  // Check if destination mountpoint is already used.
  const mountpointDirectoryExists = fs.existsSync(mountpoint)
  if (!mountpoint || (mountpointDirectoryExists && fs.readdirSync(mountpoint).length > 0)) {
    throw Error(`Destination mountpoint "${mountpoint}" is not free.`)
  }
  if (process.platform === 'linux' && !mountpointDirectoryExists) {
    fs.mkdirSync(mountpoint)
  }

  proc.create([
    'mount',
    getBookmarkRemoteWithRoot(bookmark),
    mountpoint,
    '--attr-timeout', Math.max(1, parseInt(settings.get('rclone_cache_files'))) + 's',
    '--dir-cache-time', Math.max(1, parseInt(settings.get('rclone_cache_directories'))) + 's',
    '--allow-non-empty',
    '--volname', bookmark.$name,
    '-vv'
  ])
  proc.set('mountpoint', mountpoint)

  if (process.platform === 'linux') {
    proc.getProcess().on('close', function () {
      freeMountpointDirectory(mountpoint)
      if (fs.existsSync(mountpoint)) {
        fs.readdir(mountpoint, function (err, files) {
          if (err) {
            throw err
          }
          if (!files.length) {
            fs.rmdir(mountpoint, function () { })
          }
        })
      }
    })
  }

  fireRcloneUpdateActions()
}

/**
 * Check is given bookmark is mounted
 * @param {{}|string} bookmark
 * @returns {false|string Mountpoint}
 */
const getMountStatus = function (bookmark) {
  bookmark = getBookmark(bookmark)
  let proc = new BookmarkProcessManager('mount', bookmark.$name)
  let exists = proc.exists()
  if (exists) {
    let mountpoint = proc.get('mountpoint')
    if (fs.existsSync(mountpoint)) {
      return mountpoint
    }
  }
  return false
}

/**
 * Unmount given bookmark (if it's mounted)
 * @param {{}|string} bookmark
 */
const unmount = function (bookmark) {
  bookmark = getBookmark(bookmark)
  let proc = new BookmarkProcessManager('mount', bookmark.$name)
  if (proc.exists()) {
    proc.kill()
  }
}

/**
 * Open mounted directory bookmark in platform's file browser
 * @param {{}|string} bookmark
 */
const openMountPoint = function (bookmark) {
  let mountpoint = getMountStatus(bookmark)
  if (mountpoint) {
    shell.openExternal(`file://${mountpoint}`)
  } else {
    console.error('Trying to open non-mounted drive.')
  }
}

/**
 * Perform download task
 * @see sync()
 * @param {{}|string} bookmark
 */
const download = function (bookmark) {
  sync('download', getBookmark(bookmark))
}

/**
 * Perform upload task
 * @see sync()
 * @param {{}|string} bookmark
 */
const upload = async function(bookmark) {
  try {
    const response = await makeRcloneRequest('POST', '/operations/copyfile', {
      srcFs: bookmark._rclonetray_local_path_map,
      dstFs: getBookmarkRemoteWithRoot(bookmark),
      _async: true
    });
    return response;
  } catch (error) {
    console.error('Upload failed:', error);
    throw error;
  }
}

/**
 * Check if current is uploading
 * @param {{}|string} bookmark
 * @returns {boolean}
 */
const isUpload = function (bookmark) {
  bookmark = getBookmark(bookmark)
  return (new BookmarkProcessManager('upload', bookmark.$name)).exists()
}

/**
 * Check if current is downloading
 * @param {{}|string} bookmark
 * @returns {boolean}
 */
const isDownload = function (bookmark) {
  bookmark = getBookmark(bookmark)
  return (new BookmarkProcessManager('download', bookmark.$name)).exists()
}

/**
 * Stop currently running downloading process
 * @param {{}|string} bookmark
 */
const stopDownload = function (bookmark) {
  bookmark = getBookmark(bookmark);
  (new BookmarkProcessManager('download', bookmark.$name)).kill()
}

/**
 * Stop currently running uploading process
 * @param {{}|string} bookmark
 */
const stopUpload = function (bookmark) {
  bookmark = getBookmark(bookmark);
  (new BookmarkProcessManager('upload', bookmark.$name)).kill()
}

/**
 *
 * @param {*} bookmark
 */
const isAutomaticUpload = function (bookmark) {
  bookmark = getBookmark(bookmark)
  return !!AutomaticUploadRegistry.hasOwnProperty(bookmark.$name)
}

/**
 *
 * @param {*} bookmark
 */
const toggleAutomaticUpload = function (bookmark) {
  bookmark = getBookmark(bookmark)

  if (AutomaticUploadRegistry.hasOwnProperty(bookmark.$name)) {
    if (AutomaticUploadRegistry[bookmark.$name].timer) {
      clearTimeout(AutomaticUploadRegistry[bookmark.$name])
    }
    AutomaticUploadRegistry[bookmark.$name].watcher.close()
    delete AutomaticUploadRegistry[bookmark.$name]
  } else if ('_rclonetray_local_path_map' in bookmark && bookmark._rclonetray_local_path_map) {
    // Set the registry.
    AutomaticUploadRegistry[bookmark.$name] = {
      watcher: null,
      timer: null
    }

    AutomaticUploadRegistry[bookmark.$name].watcher = chokidar.watch(bookmark._rclonetray_local_path_map, {
      ignoreInitial: true,
      disableGlobbing: true,
      usePolling: false,
      useFsEvents: true,
      persistent: true,
      alwaysStat: true,
      atomic: true
    })

    AutomaticUploadRegistry[bookmark.$name].watcher.on('raw', function () {
      if (AutomaticUploadRegistry[bookmark.$name].timer) {
        clearTimeout(AutomaticUploadRegistry[bookmark.$name].timer)
      }
      AutomaticUploadRegistry[bookmark.$name].timer = setTimeout(function () {
        sync('upload', bookmark)
      }, 3000)
    })
  }

  fireRcloneUpdateActions()
}

/**
 * Open local path mapping
 * @param {{}|string} bookmark
 */
const openLocal = function (bookmark) {
  bookmark = getBookmark(bookmark)
  if ('_rclonetray_local_path_map' in bookmark) {
    if (fs.existsSync(bookmark._rclonetray_local_path_map)) {
      return shell.openExternal(`file://${bookmark._rclonetray_local_path_map}`)
    } else {
      console.error('Rclone', 'Local path does not exists.', bookmark._rclonetray_local_path_map, bookmark.$name)
      throw Error(`Local path ${bookmark._rclonetray_local_path_map} does not exists`)
    }
  } else {
    return false
  }
}

/**
 * Get available serving protocols
 * @returns {{}}
 */
const getAvailableServeProtocols = function () {
  let protocols = {}
  if (settings.get('rclone_serving_http_enable')) {
    protocols.http = 'HTTP'
  }
  if (settings.get('rclone_serving_ftp_enable')) {
    protocols.ftp = 'FTP'
  }
  if (settings.get('rclone_serving_webdav_enable')) {
    protocols.webdav = 'WebDAV'
  }
  if (settings.get('rclone_serving_restic_enable')) {
    protocols.restic = 'Restic'
  }
  return protocols
}

/**
 * Start serving protocol+bookmark
 * @param {string} protocol
 * @param {{}|string} bookmark
 */
const serveStart = function (protocol, bookmark) {
  try {
    if (!getAvailableServeProtocols().hasOwnProperty(protocol)) {
      throw Error(`Protocol "${protocol}" is not supported`)
    }

    bookmark = getBookmark(bookmark)
    let proc = new BookmarkProcessManager(`serve_${protocol}`, bookmark.$name)

    if (proc.exists()) {
      throw Error(`${bookmark.$name} is already serving.`)
    }

    let command = [
      'serve',
      protocol,
      getBookmarkRemoteWithRoot(bookmark),
      '--addr', '127.0.0.1:5572',
      '--user', settings.get('rclone_serving_username'),
      '--pass', settings.get('rclone_serving_password'),
      '--rc',
      '--rc-addr', '127.0.0.1:5572',
      '--rc-user', settings.get('rclone_serving_username'),
      '--rc-pass', settings.get('rclone_serving_password'),
      '--rc-allow-origin=*',
      '--rc-web-gui',
      '--rc-no-auth',
      '-vv'
    ]

    proc.create(command)
    proc.set('protocol', protocol)
    proc.set('URI', `http://127.0.0.1:5572`)
    fireRcloneUpdateActions()
  } catch (err) {
    console.error('Rclone serve error:', err)
    throw err
  }
}

/**
 * Stop serving protocol+bookmark
 * @param {string} protocol
 * @param {{}|string} bookmark
 */
const serveStop = function (protocol, bookmark) {
  bookmark = getBookmark(bookmark)
  if (serveStatus(protocol, bookmark) !== false) {
    let proc = new BookmarkProcessManager(`serve_${protocol}`, bookmark.$name)
    if (proc.exists()) {
      proc.kill()
    }
  }
}

/**
 * Check if current protocol+bookmark is in serving
 * @param {string} protocol
 * @param {{}} bookmark
 * @returns {string|boolean}
 */
const serveStatus = function (protocol, bookmark) {
  bookmark = getBookmark(bookmark)
  let proc = new BookmarkProcessManager(`serve_${protocol}`, bookmark.$name)
  if (proc.exists()) {
    return proc.get('URI') || ''
  } else {
    return false
  }
}

/**
 * Open NCDU in platform's terminal emulator
 * @param {{}|string} bookmark
 */
const openNCDU = function (bookmark) {
  bookmark = getBookmark(bookmark)
  let command = prepareRcloneCommand(['ncdu', getBookmarkRemoteWithRoot(bookmark)])
  command = appendCustomRcloneCommandArgs(command, bookmark.$name)
  doCommandInTerminal(command)
}

/**
 * Get version of installed Rclone
 * @returns {string}
 */
const getVersion = function () {
  return Cache.version
}

/**
 * Init Rclone
 */
const init = async function () {
  const startRcloneServer = async function() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout starting rclone server'));
      }, 10000);
  
      try {
        // Ensure config file exists
        ensureConfigFile();
        
        const rclonePath = getRcloneBinary();
        console.log('Starting rclone server with binary:', rclonePath);
  
        // Modified command arguments to enable web GUI and proper authentication
        const server = spawn(rclonePath, [
          'rcd',
          // '--rc-web-gui', // Enable web GUI
          // '--rc-web-gui-no-open-browser', // Don't auto-open browser
          '--rc-addr=127.0.0.1:5572',
          '--rc-serve',  // Enable serving capability
          '--rc-user', settings.get('rclone_serving_username'),
          '--rc-pass', settings.get('rclone_serving_password'),
          '--rc-allow-origin=*', // Allow CORS for web access
          '--rc-files', // Enable file serving
          '--config', Cache.configFile
        ]);
  
        server.on('error', (err) => {
          clearTimeout(timeout);
          console.error('Failed to start rclone server:', err);
          reject(err);
        });
  
        // Better output detection for server start
        let serverStarted = false;
        
        server.stdout.on('data', (data) => {
          const output = data.toString();
          console.log('Rclone server output:', output);
          
          // Check for multiple possible success indicators
          if (output.includes('Serving remote control') || 
              output.includes('Server started on') ||
              output.includes('Serving rclone') ||
              output.includes('Web GUI is not automatically opening browser')) {
            if (!serverStarted) {
              serverStarted = true;
              clearTimeout(timeout);
              Cache.rcloneServer = server;
              
              // Additional health check
              makeRcloneRequest('POST', '/core/version')
                .then(() => {
                  console.log('Rclone server is responding to API requests');
                  resolve();
                })
                .catch((error) => {
                  console.error('Server started but not responding to API:', error);
                  reject(new Error('Server started but API is not responding'));
                });
            }
          }
        });
  
        server.stderr.on('data', (data) => {
          const error = data.toString();
          console.error('Rclone server error:', error);
          // Don't reject on stderr as some versions output normal logs here
          if (error.includes('Fatal error') || error.includes('panic:')) {
            clearTimeout(timeout);
            reject(new Error(`Fatal rclone server error: ${error}`));
          }
        });
  
        // Handle server exit
        server.on('close', (code) => {
          if (!serverStarted) {
            clearTimeout(timeout);
            reject(new Error(`Rclone server exited with code ${code} before starting`));
          } else {
            console.log(`Rclone server closed with code ${code}`);
            Cache.rcloneServer = null;
          }
        });
  
      } catch (err) {
        clearTimeout(timeout);
        console.error('Error in startRcloneServer:', err);
        reject(err);
      }
    });
  };

  try {
    // Start the rclone server
    await startRcloneServer();

    // Initialize caches
    await updateVersionCache();
    await updateBookmarksCache();
    updateProvidersCache();

  } catch (error) {
    console.error('Rclone initialization failed:', error);
    dialogs.notification('Failed to initialize rclone: ' + error.message);
    throw error;
  }
};

/**
 * Prepare app to quit, show dialog if there is running processes
 * @param {Event} event
 */
const prepareQuit = async function (event) {
  // Kill rclone server if running
  if (Cache.rcloneServer) {
    Cache.rcloneServer.kill();
  }

  // Kill all bookmark processes
  BookmarkProcessManager.killAll();
  
  // Clear automatic upload watchers
  Object.values(AutomaticUploadRegistry).forEach(function (watcher) {
    watcher.close();
  });
};

const makeRcloneRequest = async function(method, path, data = null) {
  try {
    const username = settings.get('rclone_serving_username');
    const password = settings.get('rclone_serving_password');
    const baseUrl = 'http://127.0.0.1:5572';
    
    const headers = {
      'Authorization': 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
      'Content-Type': 'application/json'
    };

    const options = {
      method: method,
      headers: headers
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(`${baseUrl}${path}`, options);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Rclone API request failed:', error);
    throw error;
  }
}

const listDirectory = async function(remotePath) {
  try {
    const response = await makeRcloneRequest('POST', '/operations/list', {
      fs: remotePath,
      remote: ""
    });
    return response.list;
  } catch (error) {
    console.error('List directory failed:', error);
    throw error;
  }
}

const copyFile = async function(srcFs, dstFs) {
  try {
    const response = await makeRcloneRequest('POST', '/operations/copyfile', {
      srcFs: srcFs,
      srcRemote: "",
      dstFs: dstFs,
      dstRemote: ""
    });
    return response;
  } catch (error) {
    console.error('Copy file failed:', error);
    throw error;
  }
}

const moveFile = async function(srcFs, dstFs) {
  try {
    const response = await makeRcloneRequest('POST', '/operations/movefile', {
      srcFs: srcFs,
      srcRemote: "",
      dstFs: dstFs,
      dstRemote: ""
    });
    return response;
  } catch (error) {
    console.error('Move file failed:', error);
    throw error;
  }
}

const deleteFile = async function(fs, path) {
  try {
    const response = await makeRcloneRequest('POST', '/operations/deletefile', {
      fs: fs,
      remote: path
    });
    return response;
  } catch (error) {
    console.error('Delete file failed:', error);
    throw error;
  }
}

const uploadFile = async function(bookmark, localPath) {
  try {
    const response = await makeRcloneRequest('POST', '/operations/copyfile', {
      srcFs: localPath,
      dstFs: getBookmarkRemoteWithRoot(bookmark),
      _async: true
    });
    return response;
  } catch (error) {
    console.error('Upload failed:', error);
    throw error;
  }
}

const downloadFile = async function(bookmark, remotePath, localPath) {
  try {
    const response = await makeRcloneRequest('POST', '/operations/copyfile', {
      srcFs: getBookmarkRemoteWithRoot(bookmark) + "/" + remotePath,
      dstFs: localPath,
      _async: true
    });
    return response;
  } catch (error) {
    console.error('Download failed:', error);
    throw error;
  }
}

const ensureConfigFile = function() {
  const configPath = settings.get('rclone_config');
  if (!configPath) {
    const defaultPath = path.join(app.getPath('userData'), 'rclone.conf');
    settings.set('rclone_config', defaultPath);
    Cache.configFile = defaultPath;
    
    if (!fs.existsSync(defaultPath)) {
      fs.writeFileSync(defaultPath, '');
    }
  } else {
    Cache.configFile = configPath;
  }
};

/**
 * Get path to rclone binary
 * @returns {string}
 * @private
 */
const getRcloneBinary = function () {
  if (settings.get('rclone_use_bundled')) {
    return RcloneBinaryBundled;
  }
  return RcloneBinaryName;
}

// Exports.
module.exports = {
  getConfigFile,

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

  prepareQuit,

  listDirectory,
  copyFile,
  moveFile,
  deleteFile,
  uploadFile,
  downloadFile,
  makeRcloneRequest
}
