const { dialog } = require('electron');
const fs = require('fs');
const dialogs = require('./dialogs')


class RcloneSyncService {
    constructor(apiService, getSyncConfig, saveSyncConfig) {
        if (!apiService) throw new Error('apiService is required for RcloneSyncService');
        if (!getSyncConfig) throw new Error('getSyncConfig is required for RcloneSyncService');
        if (!saveSyncConfig) throw new Error('saveSyncConfig is required for RcloneSyncService');

        this.apiService = apiService;
        this.getSyncConfig = getSyncConfig;
        this.saveSyncConfig = saveSyncConfig;
        this.activeSyncs = new Map();
        this.healthCheckInterval = 30000;
        this.jobTimeout = 3600000; // 1 hour timeout for jobs
        this._startHealthCheck();
    }

    async _makeJobRequest(endpoint, params = {}, timeout = null) {
        const requestId = Math.random().toString(36).substring(7);
        console.log(`[${requestId}] Starting job request to ${endpoint}`, params);

        try {
            const response = await this.apiService.makeRequest(endpoint, 'POST', {
                ...params,
                _async: true
            });

            if (!response || !response.jobid) {
                throw new Error('Failed to get job ID from response');
            }

            console.log(`[${requestId}] Job started with ID: ${response.jobid}`);
            return response.jobid;
        } catch (error) {
            console.error(`[${requestId}] Job request failed:`, error);
            throw error;
        }
    }

    async _waitForJob(jobId, timeout = this.jobTimeout) {
        const startTime = Date.now();
        const requestId = Math.random().toString(36).substring(7);

        while (true) {
            if (Date.now() - startTime > timeout) {
                throw new Error(`Job timeout exceeded after ${timeout}ms`);
            }

            try {
                const status = await this.apiService.makeRequest('job/status', 'POST', { jobid: jobId });
                
                if (status.finished) {
                    console.log(`[${requestId}] Job ${jobId} finished:`, status);
                    if (status.error) throw new Error(status.error);
                    return status;
                }
            } catch (error) {
                if (error.message && error.message.includes('job not found')) {
                    console.log(`[${requestId}] Job ${jobId} not found, assuming completed`);
                    return null;
                }
                throw error;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    async _runBisync(remotePath, localPath, useResync = false) {
        const requestId = Math.random().toString(36).substring(7);
        console.log(`[${requestId}] Starting bisync:`, { remotePath, localPath, useResync });

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
            baseArgs.push('--resync', '--resync-mode', 'newer');
        }

        try {
            const jobId = await this._makeJobRequest('core/command', {
                command: 'bisync',
                arg: baseArgs
            });

            return jobId;
        } catch (error) {
            console.error(`[${requestId}] Bisync failed:`, error);
            throw error;
        }
    }

    async _initialSync(remotePath, localPath) {
        const requestId = Math.random().toString(36).substring(7);
        console.log(`[${requestId}] Starting initial sync:`, { remotePath, localPath });

        try {
            const jobId = await this._makeJobRequest('core/command', {
                command: 'sync',
                arg: [
                    remotePath,
                    localPath,
                    '--create-empty-src-dirs',
                    '--inplace',
                    '--verbose',
                    '--track-renames',
                    '--ignore-existing',
                    '--modify-window', '2s',
                    '--timeout', '30s',
                    '--transfers', '1'
                ]
            });

            await this._waitForJob(jobId);
            console.log(`[${requestId}] Initial sync completed`);
        } catch (error) {
            console.error(`[${requestId}] Initial sync failed:`, error);
            throw error;
        }
    }

    _formatRemotePath(bookmark, path) {
        return `${bookmark.$name}:${path}`;
    }

    _getSyncKey(bookmark, configName) {
        return `${bookmark.$name}_${configName}`;
    }

    _startHealthCheck() {
        setInterval(async () => {
            const checkId = Math.random().toString(36).substring(7);
            console.log(`[${checkId}] Starting health check for ${this.activeSyncs.size} syncs`);

            for (const [syncKey, syncInfo] of this.activeSyncs) {
                try {
                    await this._checkSyncHealth(syncKey, syncInfo, checkId);
                } catch (error) {
                    console.error(`[${checkId}] Health check failed for ${syncKey}:`, error);
                }
            }
        }, this.healthCheckInterval);
    }

    async _checkSyncHealth(syncKey, syncInfo, checkId) {
        try {
            const status = await this.apiService.makeRequest('job/status', 'POST', {
                jobid: syncInfo.jobId
            });

            if (status.finished) {
                console.log(`[${checkId}] Bisync finished for ${syncKey}:`, status);

                if (status.error) {
                    console.error(`[${checkId}] Bisync error:`, status.error);
                    this.activeSyncs.delete(syncKey);
                    return;
                }

                const now = Date.now();
                if (now - syncInfo.lastRunTime >= this.healthCheckInterval) {
                    const [bookmarkName, configName] = syncKey.split('_');
                    const bookmark = { $name: bookmarkName };

                    this.activeSyncs.delete(syncKey);
                    await this.startSync(bookmark, syncInfo.config);
                }
            }
        } catch (error) {
            if (error.message && error.message.includes('job not found')) {
                console.log(`[${checkId}] Job not found, removing from active syncs:`, syncKey);
                this.activeSyncs.delete(syncKey);
            } else {
                console.error(`[${checkId}] Health check error:`, error);
            }
        }
    }

    async startSync(bookmark, config) {
        if (!config || !config.localPath || !config.remotePath) {
            throw new Error('Invalid sync configuration');
        }

        const requestId = Math.random().toString(36).substring(7);
        const syncKey = this._getSyncKey(bookmark, config.name);
        
        console.log(`[${requestId}] Starting sync:`, { syncKey, config });

        if (this.activeSyncs.has(syncKey)) {
            try {
                const status = await this.apiService.makeRequest('job/status', 'POST', {
                    jobid: this.activeSyncs.get(syncKey).jobId
                });

                if (!status.finished) {
                    console.log(`[${requestId}] Sync already active:`, syncKey);
                    dialogs.notification(`Sync already active for ${bookmark.$name}`);

                    return false;
                }
            } catch (error) {
                console.log(`[${requestId}] Error checking existing sync:`, error);
            }
            this.activeSyncs.delete(syncKey);
        }

        try {
            const localPath = config.localPath;
            const remotePath = this._formatRemotePath(bookmark, config.remotePath);
            let jobId;

            const syncConfig = this.getSyncConfig(bookmark, config.name);
            const isInitialized = syncConfig && syncConfig._rclonetray_sync_initialized === 'true';

            if (!isInitialized) {
                console.log(`[${requestId}] First run, initializing`);
                await this._initialSync(remotePath, localPath);
                jobId = await this._runBisync(remotePath, localPath, true);
                await this._waitForJob(jobId);
                await this._saveInitializationStatus(bookmark, config);
                jobId = await this._runBisync(remotePath, localPath, false);
                dialogs.notification(`Successfully initialized sync for ${bookmark.$name}`);
            } else {
                console.log(`[${requestId}] Directory already initialized, starting bisync`);
                jobId = await this._runBisync(remotePath, localPath, false);
                dialogs.notification(`Started sync for ${bookmark.$name}`);

            }

            this.activeSyncs.set(syncKey, {
                jobId,
                config,
                startTime: Date.now(),
                lastRunTime: Date.now()
            });

            return true;
        } catch (error) {
            console.error(`[${requestId}] Sync start failed:`, error);
            dialogs.notification(`Failed to start sync for ${bookmark.$name}: ${error.message}`);
            throw error;
        }
    }

    async stopSync(bookmark, syncName) {
        const requestId = Math.random().toString(36).substring(7);
        const syncKey = this._getSyncKey(bookmark, syncName);
        
        console.log(`[${requestId}] Stopping sync:`, syncKey);

        const syncInfo = this.activeSyncs.get(syncKey);
        if (!syncInfo) {
            console.log(`[${requestId}] Sync not found:`, syncKey);
            return false;
        }

        try {
            await this.apiService.makeRequest('job/stop', 'POST', {
                jobid: syncInfo.jobId
            });

            this.activeSyncs.delete(syncKey);
            console.log(`[${requestId}] Sync stopped:`, syncKey);
            return true;
        } catch (error) {
            if (error.message && error.message.includes('job not found')) {
                this.activeSyncs.delete(syncKey);
                return true;
            }
            console.error(`[${requestId}] Stop sync failed:`, error);
            throw error;
        }
    }

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
            console.log('Initialization status saved for', bookmark.$name, config.name);
        } catch (error) {
            console.error('Error saving initialization status:', error);
            throw error;
        }
    }

    async cleanup() {
        const requestId = Math.random().toString(36).substring(7);
        console.log(`[${requestId}] Starting cleanup for ${this.activeSyncs.size} syncs`);

        const cleanupPromises = [];

        for (const [syncKey, syncInfo] of this.activeSyncs) {
            try {
                const [bookmarkName, syncName] = syncKey.split('_');
                cleanupPromises.push(
                    this.stopSync({ $name: bookmarkName }, syncName)
                        .catch(error => {
                            console.error(`[${requestId}] Cleanup failed for ${syncKey}:`, error);
                        })
                );
            } catch (error) {
                console.error(`[${requestId}] Error preparing cleanup for ${syncKey}:`, error);
            }
        }

        try {
            await Promise.allSettled(cleanupPromises);
            this.activeSyncs.clear();
            console.log(`[${requestId}] All sync resources cleaned up`);
        } catch (error) {
            console.error(`[${requestId}] Final cleanup failed:`, error);
            throw error;
        }
    }

    getSyncStatus(bookmark, syncName) {
        const syncKey = this._getSyncKey(bookmark, syncName);
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
}

module.exports = RcloneSyncService;