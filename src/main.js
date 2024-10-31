'use strict'

const path = require('path')
const { app } = require('electron')
const isDev = require('electron-is-dev')
const dialogs = require('./dialogs')
const rclone = require('./rclone')
const tray = require('./tray')

// Error handler
process.on('uncaughtException', function (error) {
  console.error('Uncaught Exception:', error)
  if (dialogs.uncaughtException(error)) {
    app.exit()
  }
})

// Check arch.
if (process.arch !== 'x64') {
  throw Error('The application can started on 64bit platforms only.')
}

// Check the OS.
if (['win32', 'linux', 'darwin'].indexOf(process.platform) === -1) {
  throw Error('Unsupported platform')
}

// win32 workaround for poor rendering.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration()
}

// Do not allow multiple instances.
if (!app.requestSingleInstanceLock()) {
  if (isDev) {
    console.log('There is already started RcloneTray instance.')
  }
  app.focus()
  dialogs.errorMultiInstance()
  app.exit()
}

// For debugging purposes.
if (isDev) {
  // Export interact from console
  require('inspector').open()
  
  // Load electron-reload
  try {
    require('electron-reload')(__dirname, {
      electron: path.join(__dirname, '..', 'node_modules', '.bin', 'electron')
    })
  } catch (err) {
    console.error('Failed to load electron-reload:', err)
  }

  global.$main = {
    app: app,
    __dirname: __dirname,
    require: require,
    rclone: rclone // Добавим для отладки
  }
}

// Focus the app if second instance is going to starts.
app.on('second-instance', app.focus)

// This method will be called when Electron has finished initialization
app.on('ready', async function () {
  try {
    console.log('Initializing application...')
    
    // Initialize the tray first
    await tray.init()
    console.log('Tray initialized')

    // Initialize Rclone and connect callbacks
    await rclone.init()
    console.log('Rclone initialized')
    
    rclone.onUpdate(tray.refresh)
    await tray.refresh()
    console.log('Initial tray refresh completed')

    // Only on macOS there is app.dock.
    if (process.platform === 'darwin') {
      // Hide the app from dock and taskbar.
      app.dock.hide()
    }
  } catch (error) {
    console.error('Failed to initialize application:', error)
    dialogs.rcloneAPIError('Failed to initialize application')
    app.exit(1)
  }
})

// Prepare app to quit.
app.on('before-quit', async () => {
  await rclone.prepareQuit()
})

// Should not quit when all windows are closed,
// because the application is staying as system tray indicator.
app.on('window-all-closed', function (event) {
  event.preventDefault()
})