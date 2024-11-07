const fetch = require('node-fetch');

class RcloneApiService {
    constructor(port = 5572, user = 'user', pass = 'pass') {
        this.baseURL = `http://127.0.0.1:${port}`;
        this.auth = Buffer.from(`${user}:${pass}`).toString('base64');
        this.headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${this.auth}`,
            'Origin': 'http://localhost',
            'Connection': 'keep-alive'
        };
        this.timeout = 10000; // 10 секунд максимум на запрос
        this.pendingRequests = new Map(); // Для отслеживания зависших запросов
    }

    clearRequest(id) {
        if (this.pendingRequests.has(id)) {
            clearTimeout(this.pendingRequests.get(id));
            this.pendingRequests.delete(id);
        }
    }

    async makeRequest(endpoint, method = 'POST', data = null) {
        const requestId = Math.random().toString(36).substring(7);

        try {
            console.log(`Starting request ${requestId} to ${endpoint}`);
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
                timeout: this.timeout // Используем встроенный таймаут node-fetch
            };

            console.log('Request details:', {
                url,
                method,
                headers: options.headers,
                body: bodyStr
            });

            // Создаем промис с таймаутом
            const timeoutPromise = new Promise((_, reject) => {
                const timer = setTimeout(() => {
                    this.clearRequest(requestId);
                    reject(new Error(`Request ${requestId} timed out after ${this.timeout}ms`));
                }, this.timeout);
                
                this.pendingRequests.set(requestId, timer);
            });

            // Race между запросом и таймаутом
            const response = await Promise.race([
                fetch(url, options),
                timeoutPromise
            ]);

            // Очищаем таймер после получения ответа
            this.clearRequest(requestId);

            console.log(`Got response for ${requestId}:`, {
                status: response.status,
                statusText: response.statusText
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error ${response.status}: ${errorText}`);
            }

            const responseData = await response.json();
            return responseData;

        } catch (error) {
            console.error(`Request ${requestId} failed:`, {
                endpoint,
                message: error.message,
                cause: error.cause,
                stack: error.stack
            });
            throw error;
        } finally {
            this.clearRequest(requestId);
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
        const mountParams = {
            fs: params.fs,
            mountPoint: params.mountPoint,
            opt: params.mountOpt
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

    // Метод для быстрой проверки сервера
    async pingServer() {
        const originalTimeout = this.timeout;
        try {
            this.timeout = 2000; // Сокращаем таймаут для пинга
            const result = await this.makeRequest('core/version', 'POST', {});
            return true;
        } catch (error) {
            console.error('Server ping failed:', error.message);
            return false;
        } finally {
            this.timeout = originalTimeout;
        }
    }

    // Получить количество зависших запросов
    getPendingRequestsCount() {
        return this.pendingRequests.size;
    }

    // Метод для периодической проверки и очистки зависших запросов
    startHangingRequestsMonitor(interval = 30000) {
        setInterval(() => {
            const hangingCount = this.getPendingRequestsCount();
            if (hangingCount > 0) {
                console.warn(`Found ${hangingCount} hanging requests, cleaning up...`);
                for (const [id, timer] of this.pendingRequests.entries()) {
                    clearTimeout(timer);
                    this.pendingRequests.delete(id);
                }
            }
        }, interval);
    }
}

module.exports = RcloneApiService;