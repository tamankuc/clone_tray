class RcloneSyncService {
  constructor(apiService, dependencies) {
      this.apiService = apiService;
      this.activeSyncs = new Map();
      this.syncMonitors = new Map();
      this.getSyncConfig = dependencies.getSyncConfig;
      this.saveSyncConfig = dependencies.saveSyncConfig;
  }

  _getHistoryKey(path1, path2) {
      return `${path1}::${path2}`;
  }

  _getSyncCacheKey(bookmarkName, syncName) {
      return `${bookmarkName}@@${syncName}`;
  }

  getSyncStatus(bookmark, syncName) {
      const cacheKey = this._getSyncCacheKey(bookmark.$name, syncName);
      return this.activeSyncs.has(cacheKey);
  }

  async startSync(bookmark, syncName) {
      const config = this.getSyncConfig(bookmark, syncName);
      if (!config) {
        console.error('Sync configuration not found');
        return false;
      }
  
      const cacheKey = this._getSyncCacheKey(bookmark.$name, syncName);
      if (this.activeSyncs.has(cacheKey)) {
        console.log('Sync already running for', cacheKey);
        return false;
      }
  
      try {
        let srcFs, dstFs;
        if (config.direction === 'download') {
          srcFs = `${bookmark.$name}:${config.remotePath}`;
          dstFs = config.localPath;
        } else {
          srcFs = config.localPath;
          dstFs = `${bookmark.$name}:${config.remotePath}`;
        }
  
        console.log(`Starting sync for ${srcFs} -> ${dstFs} (mode: ${config.mode})`);
  
        let response;
        if (config.mode === 'bisync') {
          response = await this._runBisync(srcFs, dstFs, true);
        } else {
          response = await this._runSync(srcFs, dstFs);
        }
  
        if (response.jobid) {
          console.log(`Started job ${response.jobid}`);
          this.activeSyncs.set(cacheKey, {
            jobId: response.jobid,
            mode: config.mode,
            config,
            bookmark,
            startTime: Date.now(),
            path1: srcFs,
            path2: dstFs
          });
  
          this._monitorSync(cacheKey);
          return true;
        }
  
        throw new Error('Failed to start sync job');
      } catch (error) {
        console.error('Sync start error:', error);
        this.activeSyncs.delete(cacheKey);
        throw error;
      }
    }
  
    async _runBisync(path1, path2, resync) {
      return await this.apiService.makeRequest('sync/bisync', 'POST', {
        path1,
        path2,
        _async: true,
        opt: {
          'create-empty-src-dirs': true,
          'track-renames': true,
          'transfers': 10,
          'checkers': 20,
          'resync': resync,
          'force': resync,  // Добавляем force: true при resync
          'verbose': true,
          'check-access': true,
          'max-delete': '-1'
        }
      });
    }
  
    async _runSync(srcFs, dstFs) {
      return await this.apiService.makeRequest('sync/sync', 'POST', {
        srcFs,
        dstFs,
        _async: true,
        opt: {
          'create-empty-src-dirs': true,
          'track-renames': true,
          'transfers': 4,
          'checkers': 8,
          'verbose': true
        }
      });
    }
  
    async _monitorSync(cacheKey) {
      const syncInfo = this.activeSyncs.get(cacheKey);
      if (!syncInfo) {
        return;
      }
  
      try {
        const status = await this.apiService.makeRequest('job/status', 'POST', {
          jobid: syncInfo.jobId
        });
  
        if (status.finished) {
          console.log(`Job ${syncInfo.jobId} finished:`, status);
  
          if (status.error) {
            console.error('Sync error:', status.error);
            this.activeSyncs.delete(cacheKey);
  
            if (status.error.includes('bisync aborted')) {
              console.log('Bisync aborted, retrying with resync...');
              const response = await this._runBisync(syncInfo.path1, syncInfo.path2, true);
              if (response.jobid) {
                this.activeSyncs.set(cacheKey, {
                  ...syncInfo,
                  jobId: response.jobid,
                  startTime: Date.now()
                });
                this._monitorSync(cacheKey);
              }
            }
          } else {
            console.log('Sync completed successfully');
  
            if (syncInfo.mode === 'bisync') {
              console.log('Starting continuous monitoring...');
              this.activeSyncs.delete(cacheKey);
  
              setTimeout(async () => {
                try {
                  const response = await this._runBisync(syncInfo.path1, syncInfo.path2, false);
                  if (response.jobid) {
                    this.activeSyncs.set(cacheKey, {
                      ...syncInfo,
                      jobId: response.jobid,
                      startTime: Date.now()
                    });
                    this._monitorSync(cacheKey);
                  }
                } catch (error) {
                  console.error('Error starting continuous sync:', error);
                  if (error.message.includes('bisync aborted')) {
                    console.log('Bisync aborted, retrying with resync...');
                    const response = await this._runBisync(syncInfo.path1, syncInfo.path2, true);
                    if (response.jobid) {
                      this.activeSyncs.set(cacheKey, {
                        ...syncInfo,
                        jobId: response.jobid,
                        startTime: Date.now()
                      });
                      this._monitorSync(cacheKey);
                    }
                  }
                }
              }, 30000);
            } else {
              this.activeSyncs.delete(cacheKey);
            }
          }
          return;
        }
  
        this.syncMonitors.set(cacheKey, setTimeout(() => {
          this._monitorSync(cacheKey);
        }, 1000));
      } catch (error) {
        console.error('Monitor sync error:', error);
  
        if (error.message.includes('bisync aborted')) {
          console.log('Bisync aborted, retrying with resync...');
          const response = await this._runBisync(syncInfo.path1, syncInfo.path2, true);
          if (response.jobid) {
            this.activeSyncs.set(cacheKey, {
              ...syncInfo,
              jobId: response.jobid,
              startTime: Date.now()
            });
            this._monitorSync(cacheKey);
          }
        } else {
          this.syncMonitors.set(cacheKey, setTimeout(() => {
            this._monitorSync(cacheKey);
          }, 5000));
        }
      }
    }

  async _monitorSync(cacheKey) {
      const syncInfo = this.activeSyncs.get(cacheKey);
      if (!syncInfo) {
          return;
      }

      try {
          const status = await this.apiService.makeRequest('job/status', 'POST', {
              jobid: syncInfo.jobId
          });

          if (status.finished) {
              console.log(`Job ${syncInfo.jobId} finished:`, status);
              
              if (status.error) {
                  console.error('Sync error:', status.error);
                  this.activeSyncs.delete(cacheKey);
              } else {
                  console.log('Sync completed successfully');
                  
                  // После успешной синхронизации запускаем обычный bisync без resync
                  if (syncInfo.mode === 'bisync') {
                      console.log('Starting continuous monitoring...');
                      this.activeSyncs.delete(cacheKey);
                      
                      setTimeout(async () => {
                          try {
                              const response = await this.apiService.makeRequest('sync/bisync', 'POST', {
                                  path1: syncInfo.path1,
                                  path2: syncInfo.path2,
                                  _async: true,
                                  opt: {
                                      'create-empty-src-dirs': true,
                                      'track-renames': true,
                                      'transfers': 4,
                                      'checkers': 8,
                                      'resync': false,
                                      'force': false,
                                      'verbose': true
                                  }
                              });

                              if (response.jobid) {
                                  this.activeSyncs.set(cacheKey, {
                                      ...syncInfo,
                                      jobId: response.jobid,
                                      startTime: Date.now()
                                  });
                                  this._monitorSync(cacheKey);
                              }
                          } catch (error) {
                              console.error('Error starting continuous sync:', error);
                          }
                      }, 30000); // Проверяем каждые 30 секунд
                  } else {
                      this.activeSyncs.delete(cacheKey);
                  }
              }
              return;
          }

          // Продолжаем мониторинг
          this.syncMonitors.set(cacheKey, setTimeout(() => {
              this._monitorSync(cacheKey);
          }, 1000));

      } catch (error) {
          console.error('Monitor sync error:', error);
          
          if (error.message.includes('bisync aborted')) {
              console.log('Bisync aborted, cleaning up...');
              this.activeSyncs.delete(cacheKey);
              this.syncMonitors.delete(cacheKey);
          } else {
              this.syncMonitors.set(cacheKey, setTimeout(() => {
                  this._monitorSync(cacheKey);
              }, 5000));
          }
      }
  }

  async stopSync(bookmark, syncName) {
      const cacheKey = this._getSyncCacheKey(bookmark.$name, syncName);
      const syncInfo = this.activeSyncs.get(cacheKey);
      
      if (!syncInfo) {
          return false;
      }

      try {
          console.log(`Stopping sync for ${bookmark.$name}/${syncName}`);
          await this.apiService.makeRequest('job/stop', 'POST', {
              jobid: syncInfo.jobId
          });

          // Очищаем состояние
          this.activeSyncs.delete(cacheKey);
          if (this.syncMonitors.has(cacheKey)) {
              clearTimeout(this.syncMonitors.get(cacheKey));
              this.syncMonitors.delete(cacheKey);
          }

          return true;
      } catch (error) {
          console.error('Sync stop error:', error);
          // В любом случае очищаем состояние
          this.activeSyncs.delete(cacheKey);
          this.syncMonitors.delete(cacheKey);
          return false;
      }
  }

  async cleanup() {
      console.log('Cleaning up sync service...');
      // Останавливаем все активные синхронизации
      for (const [cacheKey, syncInfo] of this.activeSyncs.entries()) {
          try {
              await this.stopSync(syncInfo.bookmark, syncInfo.config.name);
          } catch (error) {
              console.error(`Failed to stop sync ${cacheKey}:`, error);
          }
      }

      // Очищаем все таймеры
      this.syncMonitors.forEach(timer => clearTimeout(timer));
      this.syncMonitors.clear();
      this.activeSyncs.clear();
  }
}

module.exports = RcloneSyncService;