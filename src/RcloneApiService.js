const fetch = require('node-fetch');

class RcloneApiService {
    constructor(port = 5572, user = 'user', pass = 'pass') {
        this.baseURL = `http://127.0.0.1:${port}`;
        this.auth = Buffer.from(`${user}:${pass}`).toString('base64');
        this.headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${this.auth}`,
            'Origin': 'http://localhost',
            'Connection': 'close'  // Важно: не держим соединение открытым
        };
        this.timeout = 10000;
    }

    async makeRequest(endpoint, method = 'POST', data = null) {
        const requestId = Math.random().toString(36).substring(7);
        let timeoutId = null;

        try {
            console.log(`[${requestId}] Starting request to ${endpoint}`);
            const url = `${this.baseURL}/${endpoint}`;
            
            const bodyData = data || {};
            const bodyStr = JSON.stringify(bodyData);
            
            const options = {
                method,
                headers: {
                    ...this.headers,
                    'Content-Length': Buffer.byteLength(bodyStr)
                },
                body: bodyStr,
                timeout: this.timeout,
                compress: false,     // Отключаем сжатие
                follow: 0,           // Отключаем редиректы
                size: 0,             // Отключаем лимит размера ответа
            };

            console.log(`[${requestId}] Request details:`, {
                url,
                method,
                headers: options.headers,
                bodyLength: Buffer.byteLength(bodyStr)
            });

            // Создаем промис с таймаутом
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`Request timeout after ${this.timeout}ms`));
                }, this.timeout);
            });

            // Race между запросом и таймаутом
            const response = await Promise.race([
                fetch(url, options),
                timeoutPromise
            ]);
            
            // Сразу очищаем таймер
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }

            console.log(`[${requestId}] Response:`, {
                status: response.status,
                statusText: response.statusText
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error ${response.status}: ${errorText}`);
            }

            // Еще один таймаут для чтения тела ответа
            const responsePromise = response.json();
            const responseTimeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error('Response parsing timeout'));
                }, 5000); // 5 секунд на парсинг ответа
            });

            const responseData = await Promise.race([
                responsePromise,
                responseTimeoutPromise
            ]);

            return responseData;

        } catch (error) {
            console.error(`[${requestId}] Request failed:`, {
                endpoint,
                message: error.message,
                code: error.code,
                stack: error.stack
            });
            throw error;
        } finally {
            // На всякий случай очищаем таймер
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
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

    async createMount(params) {
        console.log('Creating mount with params:', params);
        const mountParams = {
            fs: params.fs,
            mountPoint: params.mountPoint,
            opt: params.mountOpt
        };

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

    // Метод для быстрой проверки сервера
    async pingServer() {
        const originalTimeout = this.timeout;
        try {
            this.timeout = 2000;
            const result = await this.makeRequest('core/version', 'POST', {});
            return true;
        } catch (error) {
            console.error('Server ping failed:', error.message);
            return false;
        } finally {
            this.timeout = originalTimeout;
        }
    }
}

module.exports = RcloneApiService;