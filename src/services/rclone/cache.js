class RcloneCache {
  constructor() {
    this.version = null;
    this.configFile = '';
    this.providers = {};
    this.bookmarks = {};
    this.mountPoints = {};
    this.downloads = {};
    this.uploads = {};
    this.automaticUploads = {};
    this.servePoints = {};
    this.apiProcess = null;
    this.apiEndpoint = null;
    this.syncPoints = new Map();
    this.apiService = null;
    this.syncService = null;
  }

  clear() {
    this.version = null;
    this.providers = {};
    this.bookmarks = {};
    this.mountPoints = {};
    this.downloads = {};
    this.uploads = {};
    this.automaticUploads = {};
    this.servePoints = {};
    this.syncPoints.clear();
  }
}

module.exports = new RcloneCache();