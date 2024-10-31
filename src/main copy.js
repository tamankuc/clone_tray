'use strict'

const path = require('path')
const { app } = require('electron')
const isDev = require('electron-is-dev')
const dialogs = require('./dialogs')
const rclone = require('./rclone')
const tray = require('./tray')

// Error handler
process.on('uncaughtException', function (error) {
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
  // load electron-reload
  try {
    require('electron-reload')(__dirname, {
      electron: path.join(__dirname, '..', 'node_modules', '.bin', 'electron')
    })
  } catch (err) { }

  // @TODO Remove before release
  global.$main = {
    app: app,
    __dirname: __dirname,
    require: require
  }
}

// Focus the app if second instance is going to starts.
app.on('second-instance', app.focus)

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async function () {
  try {
    console.log('Initializing tray...');
    tray.init();

    console.log('Starting rclone server...');
    await rclone.init();
    console.log('Rclone server started successfully');
    
    rclone.onUpdate(tray.refresh);

    if (process.platform === 'darwin') {
      app.dock.hide();
    }
  } catch (error) {
    console.error('Application initialization failed:', error);
    console.error('Stack trace:', error.stack);
    dialogs.uncaughtException(error);
    app.exit();
  }
});

// Prepare app to quit.
app.on('before-quit', rclone.prepareQuit)

// Should not quit when all windows are closed,
// because the application is staying as system tray indicator.
app.on('window-all-closed', function (event) {
  event.preventDefault()
})

// Добавить после строки 15
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Use the existing dialogs.uncaughtException handler for consistency
  if (dialogs.uncaughtException(reason)) {
    app.exit();
  }
})

const checkServerStatus = async function() {
  try {
    await makeRcloneRequest('GET', '/core/version');
    return true;
  } catch (err) {
    console.error('Server status check failed:', err);
    return false;
  }
}

const init = async function () {
  const startRcloneServer = async function() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout starting rclone server'));
      }, 10000);

      try {
        ensureConfigFile();
        
        const rclonePath = getRcloneBinary();
        console.log('Starting rclone server with binary:', rclonePath);

        const server = spawn(rclonePath, [
          'rcd',
          '--rc-web-gui=false',
          '--rc-addr=127.0.0.1:5572',
          '--rc-no-auth',
          `--rc-user=${settings.get('rclone_api_username')}`,
          `--rc-pass=${settings.get('rclone_api_password')}`,
          `--rc-allow-origin=${settings.get('rclone_rc_allow_origin')}`,
          '--config', Cache.configFile
        ]);

        server.on('error', (err) => {
          clearTimeout(timeout);
          console.error('Failed to start rclone server:', err);
          reject(err);
        });

        server.stdout.on('data', (data) => {
          const output = data.toString();
          console.log('Rclone server output:', output);
          if (output.includes('Serving remote control')) {
            clearTimeout(timeout);
            Cache.rcloneServer = server;
            resolve();
          }
        });

        server.stderr.on('data', (data) => {
          console.error('Rclone server error:', data.toString());
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
