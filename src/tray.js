'use strict'

const path = require('path')
const { Tray, Menu } = require('electron')
const isDev = require('electron-is-dev')
const settings = require('./settings')
const rclone = require('./rclone')
const dialogs = require('./dialogs')
const RcloneSyncService = require('./RcloneSyncService')

// Хост для инициализированного объекта Tray
let trayIndicator = null

// Таймер для атомарного обновления
let refreshTrayMenuAtomicTimer = null

// Иконки трея
const icons = {}

// Метка для файлового браузера платформы
const fileExplorerLabel = process.platform === 'darwin'
  ? 'Finder'
  : process.platform === 'win32'
    ? 'Explorer'
    : 'File Browser'

/**
 * Роутер действий закладок
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
      await rclone.startDownload(this)
    } else if (action === 'stop-downloading') {
      await rclone.stopDownload(this)
    } else if (action === 'upload') {
      await rclone.startUpload(this)
    } else if (action === 'stop-uploading') {
      await rclone.stopUpload(this)
    } else if (action === 'toggle-automatic-upload') {
      await rclone.toggleAutoUpload(this)
    } else if (action === 'open-local') {
      shell.openPath(this._rclonetray_local_path_map)
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
 * Генерация подменю закладок
 * @param {Object} bookmark
 * @returns {Object}
 */
const generateBookmarkActionsSubmenu = function (bookmark) {
  // Проверка закладки
  if (!bookmark || !bookmark.$name) {
    console.error('Invalid bookmark:', bookmark)
    return {
      label: 'Invalid bookmark',
      enabled: false
    }
  }

  // Пропуск записей с .mount_ или .sync_
  if (bookmark.$name.includes('.mount_') || bookmark.$name.includes('.sync_')) {
    return null
  }

  // Если тип закладки отсутствует, показываем меню восстановления
  if (!bookmark.type) {
    return {
      label: bookmark.$name,
      enabled: false,
      type: 'submenu',
      submenu: [
        {
          label: 'Fix config file',
          click: bookmarkActionRouter.bind(null, 'open-config')
        },
        {
          label: 'Delete',
          enabled: true,
          click: bookmarkActionRouter.bind(bookmark, 'delete-bookmark')
        }
      ]
    }
  }

  // Основной шаблон для действительных закладок
  let template = {
    type: 'submenu',
    submenu: []
  }

  const mountOptionSets = rclone.getMountOptionSets(bookmark)
  const syncOptionSets = rclone.getSyncOptionSets(bookmark)
    
  // Добавляем точки монтирования
  mountOptionSets.forEach(mountConfig => {
    const isMounted = rclone.getMountStatus(bookmark, mountConfig.id)
    const config = rclone.getMountConfig(bookmark, mountConfig.id)
    
    if (mountConfig.id !== 'default') {
      template.submenu.push({ type: 'separator' })
    }

    const mountLabel = config.remotePath ? 
      `${mountConfig.name} (${config.remotePath})` : 
      mountConfig.name

    template.submenu.push({
      label: mountLabel,
      type: 'checkbox',
      checked: !!isMounted,
      enabled: !isMounted,
      click: () => {
        rclone.mount(bookmark, mountConfig.id)
          .then(() => refresh())
          .catch(error => console.error('Mount error:', error))
      }
    })

    if (isMounted) {
      template.submenu.push(
        {
          label: `Unmount ${mountConfig.name}`,
          click: () => {
            rclone.unmount(bookmark, mountConfig.id)
              .then(() => refresh())
              .catch(error => console.error('Unmount error:', error))
          }
        },
        {
          label: `Open ${mountConfig.name} in ${fileExplorerLabel}`,
          click: () => rclone.openMountPoint(bookmark, mountConfig.id)
        },
        {
          label: `Mount point: ${rclone.getMountPath(bookmark, mountConfig.id)}`,
          enabled: false
        }
      )
    }
  })

  // Добавляем точки синхронизации
  if (syncOptionSets.length > 0) {
    template.submenu.push({ type: 'separator' })

    syncOptionSets.forEach(sync => {
      const syncStatus = rclone.getSyncStatus(bookmark, sync.id)
      const isActive = syncStatus && syncStatus.status !== 'idle'
      
      template.submenu.push({
        label: sync.config.remotePath ? 
          `${sync.name} (${sync.config.remotePath})` : 
          sync.name,
        type: 'checkbox',
        checked: isActive,
        enabled: !isActive,
        click: () => {
          const syncService = new RcloneSyncService(rclone.Cache.apiService, rclone.getSyncConfig, rclone.saveSyncConfig)
          syncService.startSync(bookmark, sync.config)
            .then(() => refresh())
            .catch(error => {
              console.error('Sync error:', error)
              dialogs.rcloneAPIError('Sync failed: ' + error.message)
            })
        }
      })

      if (isActive) {
        template.submenu.push(
          {
            label: `Stop ${sync.name}`,
            click: () => {
              rclone.stopSync(bookmark, sync.id)
                .then(() => refresh())
                .catch(error => console.error('Stop sync error:', error))
            }
          },
          {
            label: `Open ${sync.name} in ${fileExplorerLabel}`,
            click: () => shell.openPath(sync.config.localPath)
          }
        )
      }
    })
  }

  // Добавляем кнопки действий
  template.submenu.push(
    { type: 'separator' },
    {
      label: 'Add Mount Point...',
      click: async () => {
        try {
          const existingMounts = mountOptionSets.length - 1
          const result = await dialogs.addMountPoint(bookmark, `point${existingMounts + 1}`)
          if (result) {
            refresh()
          }
        } catch (error) {
          console.error('Error adding mount point:', error)
          dialogs.rcloneAPIError('Failed to add mount point: ' + error.message)
        }
      }
    },
    {
      label: 'Add Sync Point...',
      click: async () => {
        try {
          const result = await dialogs.addSyncPoint(bookmark, `sync${syncOptionSets.length + 1}`)
          if (result) {
            refresh()
          }
        } catch (error) {
          console.error('Error adding sync point:', error)
          dialogs.rcloneAPIError('Failed to add sync point: ' + error.message)
        }
      }
    }
  )

  // Добавляем секцию загрузки/выгрузки если включено
  let isDownload = false
  let isUpload = false
  let isAutomaticUpload = false
  if (settings.get('rclone_sync_enable') && '_rclonetray_local_path_map' in bookmark && bookmark._rclonetray_local_path_map.trim()) {
    isDownload = rclone.isDownload(bookmark)
    isUpload = rclone.isUpload(bookmark)
    isAutomaticUpload = rclone.isAutomaticUpload(bookmark)
    template.submenu.push(
      { type: 'separator' },
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
      }
    )

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

  // Добавляем раздел обслуживания
  const availableServingProtocols = rclone.getAvailableServeProtocols()
  const availableServingProtocolsLen = Object.keys(availableServingProtocols).length
  let isServing = false

  if (availableServingProtocolsLen) {
    template.submenu.push({ type: 'separator' })

    Object.entries(availableServingProtocols).forEach(([protocol, name], index) => {
      const servingURI = rclone.serveStatus(protocol, bookmark)

      if (servingURI !== false) {
        isServing = true
        if (index > 0) {
          template.submenu.push({ type: 'separator' })
        }
      }

      template.submenu.push({
        type: 'checkbox',
        label: `Serve ${name}`,
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

        if (index < availableServingProtocolsLen - 1) {
          template.submenu.push({ type: 'separator' })
        }
      }
    })
  }

  // Добавляем NCDU если включено
  if (settings.get('rclone_ncdu_enable')) {
    template.submenu.push(
      { type: 'separator' },
      {
        label: 'Console Browser',
        click: bookmarkActionRouter.bind(bookmark, 'open-ncdu')
      }
    )
  }

  // Проверяем, есть ли активные соединения
  let isConnected = mountOptionSets.some(mountConfig => rclone.getMountStatus(bookmark, mountConfig.id))
  isConnected = isConnected || isDownload || isUpload || isServing || isAutomaticUpload

  // Добавляем управление закладками
  template.submenu.push(
    { type: 'separator' },
    {
      label: 'Edit',
      enabled: !isConnected,
      click: dialogs.editBookmark.bind(bookmark)
    }
  )

  // Устанавливаем метку закладки
  template.label = bookmark.$name
  if (settings.get('tray_menu_show_type')) {
    template.label += ' - ' + bookmark.type.toUpperCase()
  }

  // Добавляем индикатор соединения
  if (process.platform === 'darwin') {
    template.label = (isConnected ? '◆ ' : '') + template.label
  } else {
    template.label = (isConnected ? '● ' : '○ ') + template.label
  }

  return {
    template,
    isConnected
  }
}

/**
 * Обновление меню трея
 */
const refreshTrayMenu = function () {
  if (!trayIndicator) {
    return
  }

  if (isDev) {
    console.log('Refresh tray indicator menu')
  }

  let menuItems = []
  let isConnected = false

  // Опция добавления новой закладки
  menuItems.push({
    label: 'New Bookmark',
    click: dialogs.addBookmark,
    accelerator: 'CommandOrControl+N'
  })

  // Получаем и проверяем закладки
  const bookmarks = rclone.getBookmarks()
  
  if (Object.keys(bookmarks).length > 0) {
    menuItems.push({
      type: 'separator'
    })
    
    // Обрабатываем каждую закладку
    for (let key in bookmarks) {
      try {
        const bookmarkMenu = generateBookmarkActionsSubmenu(bookmarks[key])
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
        menuItems.push({
          label: `Error loading ${key}`,
          enabled: false
        })
      }
    }
  }

  // Добавляем стандартные пункты меню
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
    // Проверяем весь шаблон меню перед сборкой
    const validatedItems = menuItems.filter(item => {
      return item && (item.label || item.role || item.type === 'separator')
    })

    // Создаем меню
    const menu = Menu.buildFromTemplate(validatedItems)
    trayIndicator.setContextMenu(menu)

    // Обновляем иконку
    trayIndicator.setImage(isConnected ? icons.connected : icons.default)
  } catch (error) {
    console.error('Error building menu:', error)
    // Устанавливаем запасное меню в случае ошибки
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
 * Обновить меню трея
 */
const refresh = function () {
  console.log('Refreshing tray menu')
  if (refreshTrayMenuAtomicTimer) {
    clearTimeout(refreshTrayMenuAtomicTimer)
  }

  // Устанавливаем задержку для избежания множественных обновлений
  refreshTrayMenuAtomicTimer = setTimeout(refreshTrayMenu, 500)
}

/**
 * Инициализация меню трея
 */
const init = function () {
  if (trayIndicator) {
    console.error('Cannot start more than one tray indicators.')
    return
  }

  if (process.platform === 'win32') {
    console.log('Using windows icons')
    icons.default = path.join(__dirname, 'ui', 'icons', 'icon.ico')
    icons.connected = path.join(__dirname, 'ui', 'icons', 'icon-connected.ico')
  } else if (process.platform === 'linux') {
    console.log('Using linux icons')
    // Использование больших изображений исправляет проблему с размытой иконкой в некоторых DE
    icons.default = path.join(__dirname, 'ui', 'icons', 'icon.png')
    icons.connected = path.join(__dirname, 'ui', 'icons', 'icon-connected.png')
  } else {
    console.log('Using template icons')
    icons.default = path.join(__dirname, 'ui', 'icons', 'iconTemplate.png')
    icons.connected = path.join(__dirname, 'ui', 'icons', 'icon-connectedTemplate.png')
  }

  // Добавляем иконку в системный трей
  trayIndicator = new Tray(icons.default)
  console.log('Tray icon set to', icons.default)

  // Сразу обновляем меню после создания
  refresh()
}

// Экспорты
module.exports = {
  refresh,
  init
}