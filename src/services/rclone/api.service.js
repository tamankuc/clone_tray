const fetch = require('node-fetch');

class RcloneApiService {
  constructor(port, user, pass) {
    this.endpoint = `http://127.0.0.1:${port}`;
    this.auth = { user, pass };
  }

  async makeRequest(endpoint, method = 'POST', params = null) {
    try {
      const response = await fetch(`${this.endpoint}/${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${this.auth.user}:${this.auth.pass}`).toString('base64')
        },
        body: params ? JSON.stringify(params) : null
      });
      
      return await response.json();
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }

  async checkConnection() {
    try {
      await this.makeRequest('core/version');
      return true;
    } catch (error) {
      return false;
    }
  }

  async listMounts() {
    return this.makeRequest('mount/listmounts');
  }

  async createMount(params) {
    return this.makeRequest('mount/mount', 'POST', params);
  }

  async unmount(mountPoint) {
    return this.makeRequest('mount/unmount', 'POST', { mountPoint });
  }
}

module.exports = RcloneApiService;