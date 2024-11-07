const fs = require('fs');

class RcloneSyncService {
    constructor(apiService, getSyncConfig, saveSyncConfig) {
        if (!apiService) {
            throw new Error('apiService required for RcloneSyncService');
        }
        if (!getSyncConfig) {
            throw new Error('getSyncConfig required for RcloneSyncService');
        }
        if (!saveSyncConfig) {
            throw new Error('saveSyncConfig required for RcloneSyncService');
        }

        this.apiService = apiService;
        this.getSyncConfig = getSyncConfig;
        this.saveSyncConfig = saveSyncConfig;
        this.activeSyncs = new Map();
        this.healthCheckInterval = 30000;
        this.lastHealthCheck = Date.now();
        
        // Запускаем проверку здоровья
        setInterval(() => this.performHealthCheck(), this.healthCheckInterval);
    }

    async performHealthCheck() {
        const now = Date.now();
        
        // Проверяем каждую активную синхронизацию
        for (const [syncKey, syncInfo] of this.activeSyncs.entries()) {
            try {
                // Если с последней проверки прошло меньше интервала - пропускаем
                if (now - syncInfo.lastCheck < this.healthCheckInterval) {
                    continue;
                }

                console.log(`Checking health for sync: ${syncKey}`);
                
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Status check timeout')), 5000);
                });
                
                // Race между запросом статуса и таймаутом
                const status = await Promise.race([
                    this.apiService.makeRequest('job/status', 'POST', { jobid: syncInfo.jobId }),
                    timeoutPromise
                ]);

                syncInfo.lastCheck = now;

                if (status.finished) {
                    console.log(`Sync ${syncKey} finished with status:`, status);
                    
                    if (status.error) {
                        console.error(`Sync error for ${syncKey}:`, status.error);
                        this.activeSyncs.delete(syncKey);
                        continue;
                    }

                    // Для bisync запускаем новую сессию
                    if (syncInfo.config.mode === 'bisync') {
                        const [bookmarkName, configName] = syncKey.split('_');
                        console.log(`Restarting bisync for ${bookmarkName}:${configName}`);
                        
                        const bookmark = { $name: bookmarkName };
                        this.activeSyncs.delete(syncKey);
                        await this.startSync(bookmark, syncInfo.config);
                    } else {
                        this.activeSyncs.delete(syncKey);
                    }
                }
            } catch (error) {
                console.error(`Health check error for ${syncKey}:`, error);
                
                // Если ошибка говорит о том что задача не найдена - удаляем из активных
                if (error.message && error.message.includes('job not found')) {
                    console.log(`Removing lost sync ${syncKey}`);
                    this.activeSyncs.delete(syncKey);
                }
            }
        }
    }

    async _runBisync(remotePath, localPath, useResync = false) {
        try {
            console.log('Starting bisync between', remotePath, 'and', localPath, 
                      useResync ? 'with resync' : 'in normal mode');
            
            const baseArgs = [
                remotePath, 
                localPath,
                '--force',
                '--create-empty-src-dirs',
                '--resilient',
                '--ignore-case',
                '--conflict-resolve', 'newer',
                '--compare', 'modtime,size',
                '--modify-window', '2s',
                '--timeout', '30s',
                '--transfers', '1',
                '--ignore-listing-checksum',
                '-v'
            ];

            if (useResync) {
                baseArgs.push('--resync');
                baseArgs.push('--resync-mode', 'newer');
            }

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Bisync command timeout')), 30000);
            });

            const response = await Promise.race([
                this.apiService.makeRequest('core/command', 'POST', {
                    command: 'bisync',
                    arg: baseArgs,
                    _async: true
                }),
                timeoutPromise
            ]);

            if (!response || !response.jobid) {
                throw new Error('Failed to get job ID for bisync');
            }

            console.log('Bisync started with ID:', response.jobid);
            return response.jobid;
            
        } catch (error) {
            console.error('Bisync start error:', error);
            throw error;
        }
    }

    async startSync(bookmark, config) {
        try {
            if (!config || !config.localPath || !config.remotePath) {
                throw new Error('Invalid sync configuration');
            }

            const syncKey = `${bookmark.$name}_${config.name}`;
            console.log('Starting sync:', syncKey);
            
            // Проверяем существующую синхронизацию
            if (this.activeSyncs.has(syncKey)) {
                try {
                    const status = await this.apiService.makeRequest('job/status', 'POST', {
                        jobid: this.activeSyncs.get(syncKey).jobId
                    });
                    
                    if (!status.finished) {
                        console.log('Sync already active:', syncKey);
                        return false;
                    }
                } catch (error) {
                    // Игнорируем ошибку, просто удалим старую синхронизацию
                }
                this.activeSyncs.delete(syncKey);
            }

            const localPath = config.localPath;
            const remotePath = `${bookmark.$name}:${config.remotePath}`;

            let bisyncJobId;
            const initialized = this._checkInitialized(bookmark, config);

            if (!initialized) {
                console.log('First run, initializing sync');
                await this._initialSync(remotePath, localPath);
                bisyncJobId = await this._runBisync(remotePath, localPath, true);
                await this._waitForJob(bisyncJobId);
                await this._saveInitializationStatus(bookmark, config);
                bisyncJobId = await this._runBisync(remotePath, localPath, false);
            } else {
                console.log('Starting normal bisync');
                bisyncJobId = await this._runBisync(remotePath, localPath, false);
            }
            
            // Сохраняем информацию о синхронизации
            this.activeSyncs.set(syncKey, {
                jobId: bisyncJobId,
                config: config,
                startTime: Date.now(),
                lastCheck: Date.now()
            });

            return true;

        } catch (error) {
            console.error('Sync start error:', error);
            throw error;
        }
    }

    async stopSync(bookmark, syncName) {
        const syncKey = `${bookmark.$name}_${syncName}`;
        const syncInfo = this.activeSyncs.get(syncKey);
        
        if (!syncInfo) {
            console.log('Sync not found:', syncKey);
            return false;
        }

        try {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Stop sync timeout')), 5000);
            });

            await Promise.race([
                this.apiService.makeRequest('job/stop', 'POST', {
                    jobid: syncInfo.jobId
                }),
                timeoutPromise
            ]);
            
            this.activeSyncs.delete(syncKey);
            return true;
        } catch (error) {
            if (error.message && error.message.includes('job not found')) {
                this.activeSyncs.delete(syncKey);
                return true;
            }
            console.error('Stop sync error:', error);
            throw error;
        }
    }

    async cleanup() {
        const stopPromises = [];
        
        for (const [syncKey, syncInfo] of this.activeSyncs.entries()) {
            const [bookmarkName, syncName] = syncKey.split('_');
            stopPromises.push(
                this.stopSync({ $name: bookmarkName }, syncName)
                    .catch(error => {
                        console.error('Cleanup error for sync:', syncKey, error);
                    })
            );
        }

        await Promise.allSettled(stopPromises);
        this.activeSyncs.clear();
    }

    getSyncStatus(bookmark, syncName) {
        const syncKey = `${bookmark.$name}_${syncName}`;
        const syncInfo = this.activeSyncs.get(syncKey);
        
        return syncInfo ? {
            status: 'active',
            startTime: syncInfo.startTime,
            config: syncInfo.config
        } : { 
            status: 'idle' 
        };
    }
}

module.exports = RcloneSyncService;