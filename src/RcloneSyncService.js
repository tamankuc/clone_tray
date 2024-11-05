/**
 * Сервис для управления синхронизацией в Rclone
 */

const fs = require('fs'); // Добавляем импорт fs

class RcloneSyncService {
    /**
     * @param {Object} apiService - Сервис для работы с API Rclone
     * @param {Function} getSyncConfig - Функция получения конфига синхронизации
     * @param {Function} saveSyncConfig - Функция сохранения конфига синхронизации
     */
    constructor(apiService, getSyncConfig, saveSyncConfig) {
        if (!apiService) {
            throw new Error('apiService обязателен для RcloneSyncService');
        }
        if (!getSyncConfig) {
            throw new Error('getSyncConfig обязателен для RcloneSyncService');
        }
        if (!saveSyncConfig) {
            throw new Error('saveSyncConfig обязателен для RcloneSyncService');
        }

        this.apiService = apiService;
        this.getSyncConfig = getSyncConfig;
        this.saveSyncConfig = saveSyncConfig;
        this.activeSyncs = new Map();
        
        // Интервал проверки здоровья процессов (в миллисекундах)
        this.healthCheckInterval = 30000;
        this._startHealthCheck();
    }

    /**
     * Запуск периодической проверки здоровья процессов синхронизации
     * @private
     */
    _startHealthCheck() {
        setInterval(async () => {
            for (const [syncKey, syncInfo] of this.activeSyncs) {
                await this._checkSyncHealth(syncKey, syncInfo);
            }
        }, this.healthCheckInterval);
    }
 /**
     * Проверка здоровья процесса
     * @private
     */
 async _checkSyncHealth(syncKey, syncInfo) {
    try {
        const status = await this.apiService.makeRequest('job/status', 'POST', {
            jobid: syncInfo.jobId
        });

        // Если процесс завершился
        if (status.finished) {
            console.log('Процесс bisync завершился:', status);
            
            // Проверяем на ошибки
            if (status.error) {
                console.error('Ошибка bisync:', status.error);
                this.activeSyncs.delete(syncKey);
                return;
            }

            // Проверяем, прошло ли достаточно времени для следующего запуска
            const now = Date.now();
            if (now - syncInfo.lastRunTime >= this.bisyncInterval) {
                // Успешное завершение, запускаем новую сессию
                const [bookmarkName, configName] = syncKey.split('_');
                const bookmark = { $name: bookmarkName };
                const config = syncInfo.config;

                // Удаляем старую запись перед новым запуском
                this.activeSyncs.delete(syncKey);
                
                // Запускаем новую сессию
                console.log('Запуск новой сессии bisync');
                await this.startSync(bookmark, config);
            }
        }
    } catch (error) {
        if (error.message && error.message.includes('job not found')) {
            // Если задача не найдена, удаляем её из активных
            console.log('Задача не найдена, удаляем из активных:', syncKey);
            this.activeSyncs.delete(syncKey);
        } else {
            console.error('Ошибка проверки здоровья процесса:', error);
        }
    }
}
    /**
     * Проверка статуса инициализации в конфиге
     * @private
     */
    _checkInitialized(bookmark, config) {
        try {
            const syncConfig = this.getSyncConfig(bookmark, config.name);
            return !!(syncConfig && syncConfig._rclonetray_sync_initialized === 'true');
        } catch (error) {
            console.error('Ошибка проверки статуса инициализации:', error);
            return false;
        }
    }

    /**
     * Сохранение статуса инициализации
     * @private
     */
    async _saveInitializationStatus(bookmark, config) {
        try {
            const existingConfig = this.getSyncConfig(bookmark, config.name);
            
            const updatedConfig = {
                ...existingConfig,
                enabled: existingConfig ? existingConfig.enabled : false,
                localPath: config.localPath,
                remotePath: config.remotePath,
                mode: 'bisync',
                _rclonetray_sync_initialized: 'true',
                name: config.name
            };

            await this.saveSyncConfig(bookmark, updatedConfig, config.name);
            console.log('Сохранен статус инициализации для', bookmark.$name, config.name);
        } catch (error) {
            console.error('Ошибка сохранения статуса инициализации:', error);
            throw error;
        }
    }

    /**
     * Форматирование пути к удаленному хранилищу
     * @private
     */
    _formatRemotePath(bookmark, path) {
        return `${bookmark.$name}:${path}`;
    }

/**
     * Запуск bisync
     * @private
     */
async _runBisync(remotePath, localPath, useResync = false) {
    try {
        console.log('Запуск bisync между', remotePath, 'и', localPath, 
                  useResync ? 'с resync' : 'в обычном режиме');
        
        const baseArgs = [
            remotePath, 
            localPath,
            '--force',                           // Принудительная синхронизация
            '--create-empty-src-dirs',           // Создавать пустые директории
            '--resilient',                       // Устойчивость к ошибкам
            '--ignore-case',                     // Игнорировать регистр
            '--conflict-resolve', 'newer',       // Всегда выбирать более новую версию
            '--compare', 'modtime,size',         // Сравнивать по времени модификации и размеру
            '--modify-window', '2s',             // Окно модификации для сравнения времени
            '--timeout', '30s',                  // Таймаут операций
            '--transfers', '1',                  // Количество одновременных передач
            '--ignore-listing-checksum',         // Не проверять контрольные суммы при листинге
            '-v'                                 // Подробное логирование
        ];

        if (useResync) {
            // При первой синхронизации
            baseArgs.push('--resync');
            baseArgs.push('--resync-mode', 'newer'); // Выбираем более новые файлы
        }
        
        const response = await this.apiService.makeRequest('core/command', 'POST', {
            command: 'bisync',
            arg: baseArgs,
            _async: 'true'
        });

        if (!response || !response.jobid) {
            throw new Error('Не удалось получить ID задачи для bisync');
        }

        console.log('Bisync запущен с ID:', response.jobid);
        return response.jobid;
    } catch (error) {
        console.error('Ошибка запуска bisync:', error);
        throw error;
    }
}

/**
 * Запуск принудительной синхронизации
 * @public
 */
async forceSync(bookmark, config) {
    try {
        const syncKey = `${bookmark.$name}_${config.name}`;
        const syncInfo = this.activeSyncs.get(syncKey);

        // Если есть активная синхронизация, останавливаем ее
        if (syncInfo) {
            await this.stopSync(bookmark, config.name);
        }

        console.log('Запуск принудительной синхронизации:', bookmark.$name, config.name);
        
        const localPath = config.localPath;
        const remotePath = this._formatRemotePath(bookmark, config.remotePath);

        // Запускаем bisync напрямую, он сам разберется кто новее
        const bisyncJobId = await this._runBisync(remotePath, localPath, true);

        // Сохраняем информацию об активной синхронизации
        this.activeSyncs.set(syncKey, {
            jobId: bisyncJobId,
            config: config,
            startTime: Date.now(),
            lastRunTime: Date.now()
        });

        return true;
    } catch (error) {
        console.error('Ошибка принудительной синхронизации:', error);
        throw error;
    }
}
/**
 * Выполнение начальной синхронизации для выравнивания состояния
 * @private
 */
async _initialSync(remotePath, localPath) {
    try {
        console.log('Запуск начальной синхронизации между', remotePath, 'и', localPath);
        
        const response = await this.apiService.makeRequest('core/command', 'POST', {
            command: 'sync',
            arg: [
                remotePath, 
                localPath,
                '--create-empty-src-dirs',    // Создавать пустые директории
                '--inplace',                  // Прямая запись файлов
                '--verbose',                  // Подробное логирование
                '--track-renames',            // Отслеживание переименований
                '--ignore-existing',          // Игнорировать существующие файлы при конфликтах
                '--modify-window', '2s',      // Окно модификации для сравнения времени
                '--timeout', '30s',           // Таймаут операций
                '--transfers', '1'            // Количество одновременных передач
            ],
            _async: 'true'
        });

        if (!response || !response.jobid) {
            throw new Error('Не удалось получить ID задачи для начальной синхронизации');
        }

        // Ждем завершения начальной синхронизации
        await this._waitForJob(response.jobid);
        console.log('Начальная синхронизация завершена');
    } catch (error) {
        console.error('Ошибка начальной синхронизации:', error);
        throw error;
    }
}
    /**
     * Ожидание завершения задачи
     * @private
     */
    async _waitForJob(jobId, timeout = 3600000) {
        const startTime = Date.now();
        
        while (true) {
            if (Date.now() - startTime > timeout) {
                throw new Error('Превышено время ожидания задачи');
            }

            try {
                const status = await this.apiService.makeRequest('job/status', 'POST', {
                    jobid: jobId
                });

                if (status.finished) {
                    if (status.error) {
                        throw new Error(status.error);
                    }
                    return status;
                }
            } catch (error) {
                if (error.message && error.message.includes('job not found')) {
                    console.log('Задача не найдена, возможно уже завершена:', jobId);
                    return null;
                }
                throw error;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    /**
     * Запуск синхронизации
     * @public
     */
    async startSync(bookmark, config) {
        try {
            if (!config || !config.localPath || !config.remotePath) {
                throw new Error('Некорректная конфигурация синхронизации');
            }

            console.log('Запуск синхронизации:', bookmark.$name, config.name);
            const syncKey = `${bookmark.$name}_${config.name}`;
            
            // Проверяем, не запущена ли уже синхронизация
            if (this.activeSyncs.has(syncKey)) {
                const existingSync = this.activeSyncs.get(syncKey);
                try {
                    const status = await this.apiService.makeRequest('job/status', 'POST', {
                        jobid: existingSync.jobId
                    });
                    
                    if (!status.finished) {
                        console.log('Синхронизация уже активна:', syncKey);
                        return false;
                    }
                    
                    this.activeSyncs.delete(syncKey);
                } catch (error) {
                    this.activeSyncs.delete(syncKey);
                }
            }

            const localPath = config.localPath;
            const remotePath = this._formatRemotePath(bookmark, config.remotePath);

            let bisyncJobId;

            // Проверяем необходимость инициализации
            if (!this._checkInitialized(bookmark, config)) {
                console.log('Первый запуск, выполняем инициализацию');
                await this._initialSync(remotePath, localPath);
                bisyncJobId = await this._runBisync(remotePath, localPath, true);
                await this._waitForJob(bisyncJobId);
                await this._saveInitializationStatus(bookmark, config);
                bisyncJobId = await this._runBisync(remotePath, localPath, false);
            } else {
                console.log('Папка уже инициализирована, запускаем bisync');
                bisyncJobId = await this._runBisync(remotePath, localPath, false);
            }
            
            // Сохраняем информацию об активной синхронизации
            this.activeSyncs.set(syncKey, {
                jobId: bisyncJobId,
                config: config,
                startTime: Date.now(),
                lastRunTime: Date.now()
            });

            return true;
        } catch (error) {
            console.error('Ошибка запуска синхронизации:', error);
            throw error;
        }
    }

    /**
     * Остановка синхронизации
     * @public
     */
    async stopSync(bookmark, syncName) {
        const syncKey = `${bookmark.$name}_${syncName}`;
        const syncInfo = this.activeSyncs.get(syncKey);
        
        if (!syncInfo) {
            console.log('Синхронизация не найдена:', syncKey);
            return false;
        }

        try {
            await this.apiService.makeRequest('job/stop', 'POST', {
                jobid: syncInfo.jobId
            });
            
            this.activeSyncs.delete(syncKey);
            console.log('Синхронизация остановлена:', syncKey);
            return true;
        } catch (error) {
            if (error.message && error.message.includes('job not found')) {
                // Если задача не найдена, просто удаляем из активных
                this.activeSyncs.delete(syncKey);
                return true;
            }
            console.error('Ошибка остановки синхронизации:', error);
            throw error;
        }
    }

    /**
     * Получение статуса синхронизации
     * @public
     */
    getSyncStatus(bookmark, syncName) {
        const syncKey = `${bookmark.$name}_${syncName}`;
        const syncInfo = this.activeSyncs.get(syncKey);
        
        if (!syncInfo) {
            return {
                status: 'idle'
            };
        }

        return {
            status: 'active',
            startTime: syncInfo.startTime,
            config: syncInfo.config
        };
    }

/**
     * Очистка ресурсов при завершении работы
     * @public
     */
async cleanup() {
    const cleanupPromises = [];
    
    for (const [syncKey, syncInfo] of this.activeSyncs) {
        try {
            const [bookmarkName, syncName] = syncKey.split('_');
            // Добавляем каждую операцию остановки в массив промисов
            cleanupPromises.push(
                this.stopSync({ $name: bookmarkName }, syncName)
                    .catch(error => {
                        console.error('Ошибка при очистке синхронизации:', syncKey, error);
                    })
            );
        } catch (error) {
            console.error('Ошибка при подготовке очистки синхронизации:', syncKey, error);
        }
    }

    // Ждем завершения всех операций очистки
    try {
        await Promise.allSettled(cleanupPromises);
        // Очищаем Map активных синхронизаций
        this.activeSyncs.clear();
        console.log('Все ресурсы синхронизации очищены');
    } catch (error) {
        console.error('Ошибка при финальной очистке ресурсов:', error);
    }
}
}

module.exports = RcloneSyncService;