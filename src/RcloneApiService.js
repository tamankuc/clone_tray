const fetch = require('node-fetch');

class RcloneApiService {
    constructor(port = 5572, user = 'user', pass = 'pass') {
        this.baseURL = `http://127.0.0.1:${port}`;
        this.auth = Buffer.from(`${user}:${pass}`).toString('base64');
        this.headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${this.auth}`,
            'Origin': 'http://localhost'
        };
    }
    async makeRequest(endpoint, method = 'POST', data = null) {
        try {
            const url = `${this.baseURL}/${endpoint}`;
            
            // Важно! Не отправляем body для пустых данных
            const options = {
                method,
                headers: this.headers
            };

            if (data !== null) {
                const bodyStr = JSON.stringify(data);
                options.body = bodyStr;
                console.log('Request body (string):', bodyStr);
                console.log('Request body length:', bodyStr.length);
                console.log('Request body buffer:', Buffer.from(bodyStr));
                
                // Добавляем Content-Length только если есть тело
                options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
            } else {
                console.log('Empty request - no body sent');
                // Для пустых POST можно явно указать длину 0
                options.headers['Content-Length'] = '0';
            }

            console.log('Final request options:', {
                url,
                method,
                headers: options.headers,
                bodyPresent: !!options.body
            });

            const response = await fetch(url, options);
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error ${response.status}: ${errorText}`);
            }

            const responseData = await response.json();
            return responseData;

        } catch (error) {
            console.error(`API request failed for ${endpoint}:`, {
                message: error.message,
                cause: error.cause,
                stack: error.stack
            });
            throw error;
        }
    }
    async checkConnection() {
        try {
            const result = await this.makeRequest('config/listremotes');
            return true;
        } catch (error) {
            console.error('Connection check failed:', error);
            return false;
        }
    }

    async getVersion() {
        return this.makeRequest('core/version');
    }

    async getProviders() {
        return this.makeRequest('config/providers');
    }

    async getConfigDump() {
        return this.makeRequest('config/dump');
    }

    async listRemotes() {
        return this.makeRequest('config/listremotes');
    }

    async getFsInfo(fs) {
        return this.makeRequest('operations/fsinfo', 'POST', { fs });
    }

    async getStats(group = null) {
        const data = group ? { group } : {};
        return this.makeRequest('core/stats', 'POST', data);
    }

    async getBwLimit() {
        return this.makeRequest('core/bwlimit');
    }

    async setBwLimit(rate) {
        return this.makeRequest('core/bwlimit', 'POST', { rate });
    }

    // async createMount(fs, mountPoint) {
    //     return this.makeRequest('mount/mount', 'POST', {
    //         fs: fs,
    //         mountPoint: mountPoint
    //     });
    // }
    async createMount(params) {
        // API ожидает параметры на верхнем уровне, а не вложенными в fs
        const mountParams = {
            fs: params.fs,
            mountPoint: params.mountPoint,
            opt: params.mountOpt  // Переименовываем mountOpt в opt как ожидает API
        };

        console.log('Mount request params:', mountParams);
        return this.makeRequest('mount/mount', 'POST', mountParams);
    }

    async unmount(mountPoint) {
        return this.makeRequest('mount/unmount', 'POST', { mountPoint });
    }

    async listMounts() {
        return this.makeRequest('mount/listmounts', 'POST');
    }

    async unmountAll() {
        return this.makeRequest('mount/unmountall', 'POST');
    }

    async unmount(mountPoint) {
        return this.makeRequest('mount/unmount', 'POST', {
            mountPoint: mountPoint
        });
    }

    async listMounts() {
        return this.makeRequest('mount/listmounts', 'POST');
    }

    async unmountAll() {
        return this.makeRequest('mount/unmountall', 'POST');
    }
}

module.exports = RcloneApiService;