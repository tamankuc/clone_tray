'use strict'

const path = require('path')
const { Tray, Menu, shell } = require('electron')
const isDev = require('electron-is-dev')
const settings = require('./settings')
const rclone = require('./rclone')
const dialogs = require('./dialogs')

/**
 * Host the initialized Tray object.
 * @type {Tray}
 * @private
 */
let trayIndicator = null

/**
 * Host the atomic timer
 * @private
 */
let refreshTrayMenuAtomicTimer = null

/**
 * Tray icons
 * @private
 */
const icons = {}

/**
 * Label for platform's file browser
 * @private
 */
const fileExplorerLabel = process.platform === 'darwin'
  ? 'Finder'
  : process.platform === 'win32'
    ? 'Explorer'
    : 'File Browser'

/**
 * Do action with bookmark
 * @param {string} action
 * @param ...args
 */
const bookmarkActionRouter = async function (action, ...args) {
  try {
    if (action === 'mount') {
      await rclone.mount(this)
    } else if (action === 'unmount') {
      await rclone.unmount(this)
    } else if (action === 'open-mounted') {
      await rclone.openMountPoint(this)
    } else if (action === 'download') {
      await rclone.download(this)
    } else if (action === 'stop-downloading') {
      await rclone.stopDownload(this)
    } else if (action === 'upload') {
      await rclone.upload(this)
    } else if (action === 'stop-uploading') {
      await rclone.stopUpload(this)
    } else if (action === 'toggle-automatic-upload') {
      await rclone.toggleAutomaticUpload(this)
    } else if (action === 'open-local') {
      await rclone.openLocal(this)
    } else if (action === 'serve-start') {
      await rclone.serveStart(args[0], this)
    } else if (action === 'serve-stop') {
      await rclone.serveStop(args[0], this)
    } else if (action === 'open-ncdu') {
      await rclone.openNCDU(this)
    } else if (action === 'open-web-browser') {
      await shell.openExternal(args[0])
    } else if (action === 'open-config') {
      await shell.openPath(rclone.getConfigFile())
    } else if (action === 'delete-bookmark') {
      await rclone.deleteBookmark(this.$name)
    } else {
      console.error('No such action', action, args, this)
    }
  } catch (error) {
    console.error(`Error executing action ${action}:`, error)
    dialogs.rcloneAPIError(error.message)
  }
}

/**
 * Bookmark submenu
 *
 * @param {{bookmark}}
 * @returns {{}}
 */
const generateBookmarkActionsSubmenu = function (bookmark) {
  // If by some reason bookmark is broken, then show actions menu.
  if (!bookmark.$name || !bookmark.type) {
    return {
      label: bookmark.$name || '<Unknown>',
      enabled: false,
      type: 'submenu',
      submenu: [
        {
          label: 'Fix config file',
          click: bookmarkActionRouter.bind(null, 'open-config')
        },
        {
          label: 'Delete',
          enabled: !!bookmark.$name,
          click: bookmarkActionRouter.bind(bookmark, 'delete-bookmark')
        }
      ]
    }
  }

  // Main template
  let template = {
    type: 'submenu',
    submenu: []
  }

  const mountOptionSets = rclone.getMountOptionSets(bookmark);
    
  mountOptionSets.forEach(mountConfig => {
      const isMounted = rclone.getMountStatus(bookmark, mountConfig.id);
      const config = rclone.getMountConfig(bookmark, mountConfig.id);
      
      if (mountConfig.id !== 'default') {
          template.submenu.push({ type: 'separator' });
      }

      // Формируем метку с путем в remote, если он указан
      const mountLabel = config.remotePath ? 
          `${mountConfig.name} (${config.remotePath})` : 
          mountConfig.name;

      template.submenu.push({
          label: mountLabel,
          type: 'checkbox',
          checked: !!isMounted,
          enabled: !isMounted,
          click: () => {
              rclone.mount(bookmark, mountConfig.id)
                  .then(() => refresh())
                  .catch(error => console.error('Mount error:', error));
          }
      });

      if (isMounted) {
          template.submenu.push(
              {
                  label: `Unmount ${mountConfig.name}`,
                  click: () => {
                      rclone.unmount(bookmark, mountConfig.id)
                          .then(() => refresh())
                          .catch(error => console.error('Unmount error:', error));
                  }
              },
              {
                  label: `Open ${mountConfig.name} In ${fileExplorerLabel}`,
                  click: () => rclone.openMountPoint(bookmark, mountConfig.id)
              },
              {
                  label: `Mount Point: ${rclone.getMountPath(bookmark, mountConfig.id)}`,
                  enabled: false
              }
          );
      }
  });

  // Добавляем создание нового маунта через диалог
  template.submenu.push(
    { type: 'separator' },
    {
        label: 'Add Mount Point...',
        click: async () => {
            try {
                const existingMounts = mountOptionSets.length - 1;
                const result = await dialogs.addMountPoint(bookmark, `point${existingMounts + 1}`);
                if (result) {
                    refresh();
                }
            } catch (error) {
                console.error('Error adding mount point:', error);
                dialogs.rcloneAPIError('Failed to add mount point: ' + error.message);
            }
        }
    }
);


  // Download/Upload
  let isDownload = false
  let isUpload = false
  let isAutomaticUpload = false
  if (settings.get('rclone_sync_enable') && '_rclonetray_local_path_map' in bookmark && bookmark._rclonetray_local_path_map.trim()) {
    isDownload = rclone.isDownload(bookmark)
    isUpload = rclone.isUpload(bookmark)
    isAutomaticUpload = rclone.isAutomaticUpload(bookmark)
    template.submenu.push(
      {
        type: 'separator'
      },
      {
        type: 'checkbox',
        label: 'Download',
        enabled: !isAutomaticUpload && !isUpload && !isDownload,
        checked: isDownload,
        click: bookmarkActionRouter.bind(bookmark, 'download')
      },
      {
        type: 'checkbox',
        label: 'Upload',
        enabled: !isAutomaticUpload && !isUpload && !isDownload,
        checked: isUpload,
        click: bookmarkActionRouter.bind(bookmark, 'upload')
      },
      {
        type: 'checkbox',
        label: 'Automatic Upload',
        checked: isAutomaticUpload,
        click: bookmarkActionRouter.bind(bookmark, 'toggle-automatic-upload')
      })

    if (isDownload) {
      template.submenu.push({
        label: 'Stop Downloading',
        click: bookmarkActionRouter.bind(bookmark, 'stop-downloading')
      })
    }

    if (isUpload) {
      template.submenu.push({
        label: 'Stop Uploading',
        click: bookmarkActionRouter.bind(bookmark, 'stop-uploading')
      })
    }

    template.submenu.push({
      label: 'Show In Finder',
      click: bookmarkActionRouter.bind(bookmark, 'open-local')
    })
  }

  // Serving.
  let isServing = false
  let availableServingProtocols = rclone.getAvailableServeProtocols()
  let availableServingProtocolsLen = Object.keys(availableServingProtocols).length
  if (availableServingProtocolsLen) {
    template.submenu.push(
      {
        type: 'separator'
      })

    let i = 0
    Object.keys(availableServingProtocols).forEach(function (protocol) {
      i++
      let servingURI = rclone.serveStatus(protocol, bookmark)

      // Add separator before the menu item, only if current serve method is in process.
      if (servingURI !== false) {
        isServing = true
        if (i > 1) {
          template.submenu.push({
            type: 'separator'
          })
        }
      }

      template.submenu.push({
        type: 'checkbox',
        label: `Serve ${availableServingProtocols[protocol]}`,
        click: bookmarkActionRouter.bind(bookmark, 'serve-start', protocol),
        enabled: servingURI === false,
        checked: !!servingURI
      })

      if (servingURI !== false) {
        template.submenu.push(
          {
            label: 'Stop',
            click: bookmarkActionRouter.bind(bookmark, 'serve-stop', protocol)
          },
          {
            label: `Open "${servingURI}"`,
            click: bookmarkActionRouter.bind(bookmark, 'open-web-browser', servingURI),
            enabled: !!servingURI
          }
        )

        // Add separator after the menu item, only if current serve method is in process.
        if (i < availableServingProtocolsLen) {
          template.submenu.push({
            type: 'separator'
          })
        }
      }
    })
  }

  // NCDU
  if (settings.get('rclone_ncdu_enable')) {
    template.submenu.push(
      {
        type: 'separator'
      },
      {
        label: 'Console Browser',
        click: bookmarkActionRouter.bind(bookmark, 'open-ncdu')
      }
    )
  }

  // Set the menu item state if there is any kind of connection or current running process.
  let isConnected = false
  mountOptionSets.forEach(mountConfig => {
    if (rclone.getMountStatus(bookmark, mountConfig.id)) {
      isConnected = true
    }
  })
  isConnected = isConnected || isDownload || isUpload || isServing || isAutomaticUpload

  // Bookmark controls.
  template.submenu.push(
    {
      type: 'separator'
    },
    {
      label: 'Edit',
      enabled: !isConnected,
      click: dialogs.editBookmark.bind(bookmark)
    }
  )

  // Set the bookmark label
  template.label = bookmark.$name

  if (settings.get('tray_menu_show_type')) {
    template.label += ' - ' + bookmark.type.toUpperCase()
  }

  if (process.platform === 'darwin') {
    // Because Apple likes rhombuses.
    template.label = (isConnected ? '◆ ' : '') + template.label
  } else {
    template.label = (isConnected ? '● ' : '○ ') + template.label
  }

  // Usually should not goes here.
  if (!template.label) {
    template.label = '<Unknown>'
  }

  return {
    template,
    isConnected
  }
}

/**
 * Refreshing try menu.
 */
const refreshTrayMenu = function () {
  // Early return if tray isn't initialized
  if (!trayIndicator) {
    return
  }

  if (isDev) {
    console.log('Refresh tray indicator menu')
  }

  let menuItems = []
  let isConnected = false

  // Add new bookmark option
  menuItems.push({
    label: 'New Bookmark',
    click: dialogs.addBookmark,
    accelerator: 'CommandOrControl+N'
  })

  // Get and validate bookmarks
  const bookmarks = rclone.getBookmarks()
  
  if (Object.keys(bookmarks).length > 0) {
    menuItems.push({
      type: 'separator'
    })
    
    // Process each bookmark
    for (let key in bookmarks) {
      try {
        const bookmarkMenu = generateBookmarkActionsSubmenu(bookmarks[key])
        // Validate menu item before adding
        if (bookmarkMenu && bookmarkMenu.template && 
            (bookmarkMenu.template.label || bookmarkMenu.template.role || bookmarkMenu.template.type)) {
          menuItems.push(bookmarkMenu.template)
          if (bookmarkMenu.isConnected) {
            isConnected = true
          }
        } else {
          console.error('Invalid bookmark menu template generated for:', key)
        }
      } catch (error) {
        console.error('Error generating menu for bookmark:', key, error)
        // Add error placeholder menu item
        menuItems.push({
          label: `Error loading ${key}`,
          enabled: false
        })
      }
    }
  }

  // Add standard menu items
  const standardItems = [
    { type: 'separator' },
    {
      label: 'Preferences',
      click: dialogs.preferences,
      accelerator: 'CommandOrControl+,'
    },
    {
      label: 'About',
      click: dialogs.about
    },
    { type: 'separator' },
    {
      label: 'Quit',
      accelerator: 'CommandOrControl+Q',
      role: 'quit'
    }
  ]

  menuItems.push(...standardItems)

  try {
    // Validate entire menu template before building
    const validatedItems = menuItems.filter(item => {
      return item && (item.label || item.role || item.type === 'separator')
    })

    // Set the menu
    const menu = Menu.buildFromTemplate(validatedItems)
    trayIndicator.setContextMenu(menu)

    // Update icon
    trayIndicator.setImage(isConnected ? icons.connected : icons.default)
  } catch (error) {
    console.error('Error building menu:', error)
    // Set fallback menu if main menu fails
    const fallbackMenu = Menu.buildFromTemplate([
      {
        label: 'Error Loading Menu',
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Quit',
        role: 'quit'
      }
    ])
    trayIndicator.setContextMenu(fallbackMenu)
  }
}


/**
 * Refresh the tray menu.
 */
const refresh = function () {
  console.log('Refreshing tray menu')
  // Use some kind of static variable to store the timer
  if (refreshTrayMenuAtomicTimer) {
    clearTimeout(refreshTrayMenuAtomicTimer)
  }

  // Set some delay to avoid multiple updates in close time.
  refreshTrayMenuAtomicTimer = setTimeout(refreshTrayMenu, 500)
}

/**
 * Initialize the tray menu.
 */
const init = function () {
  if (trayIndicator) {
    // Avoid double tray loader
    console.error('Cannot start more than one tray indicators.')
    return
  }

  if (process.platform === 'win32') {
    console.log('Using windows icons')
    icons.default = path.join(__dirname, 'ui', 'icons', 'icon.ico')
    icons.connected = path.join(__dirname, 'ui', 'icons', 'icon-connected.ico')
  } else if (process.platform === 'linux') {
    console.log('Using linux icons')
    // Using bigger images fixes the problem with blurry icon in some DE.
    icons.default = path.join(__dirname, 'ui', 'icons', 'icon.png')
    icons.connected = path.join(__dirname, 'ui', 'icons', 'icon-connected.png')
  } else {
    console.log('Using template icons')
    icons.default = path.join(__dirname, 'ui', 'icons', 'iconTemplate.png')
    icons.connected = path.join(__dirname, 'ui', 'icons', 'icon-connectedTemplate.png')
  }

  // Add system tray icon.
  trayIndicator = new Tray(icons.default)
  console.log('Tray icon set to', icons.default)
}

// Exports.
module.exports = {
  refresh: refresh,
  init: init
}
