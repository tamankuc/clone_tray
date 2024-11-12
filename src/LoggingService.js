'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const isDev = require('electron-is-dev');
const settings = require('./settings')

class LoggingService {
    constructor() {
        this.logFile = path.join(settings.get('log_app_path'), `rclonetray-${new Date().toISOString().split('T')[0]}.log`);
        this.initLogDirectory();
        this.rotateOldLogs();
    }

    // Инициализация директории для логов
    initLogDirectory() {
        const logDir = path.dirname(this.logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }

    // Ротация старых логов (удаление логов старше 30 дней)
    rotateOldLogs() {
        try {
            const logDir = path.dirname(this.logFile);
            const files = fs.readdirSync(logDir);
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            files.forEach(file => {
                if (file.startsWith('rclonetray-') && file.endsWith('.log')) {
                    const filePath = path.join(logDir, file);
                    const fileDate = new Date(file.replace('rclonetray-', '').replace('.log', ''));
                    if (fileDate < thirtyDaysAgo) {
                        fs.unlinkSync(filePath);
                    }
                }
            });
        } catch (error) {
            console.error('Error rotating logs:', error);
        }
    }

    // Форматирование сообщения лога
    formatLogMessage(level, message, context = {}) {
        const timestamp = new Date().toISOString();
        const contextStr = Object.keys(context).length ? 
            ` | ${JSON.stringify(context)}` : '';
        return `[${timestamp}] ${level.toUpperCase()}: ${message}${contextStr}\n`;
    }

    // Запись лога в файл
    async writeToFile(formattedMessage) {
        try {
            await fs.promises.appendFile(this.logFile, formattedMessage);
        } catch (error) {
            console.error('Error writing to log file:', error);
        }
    }

    // Основные методы логирования
    async info(message, context = {}) {
        const formattedMessage = this.formatLogMessage('INFO', message, context);
        if (isDev) {
            console.log(formattedMessage.trim());
        }
        await this.writeToFile(formattedMessage);
    }

    async warn(message, context = {}) {
        const formattedMessage = this.formatLogMessage('WARN', message, context);
        if (isDev) {
            console.warn(formattedMessage.trim());
        }
        await this.writeToFile(formattedMessage);
    }

    async error(message, context = {}) {
        const formattedMessage = this.formatLogMessage('ERROR', message, context);
        if (isDev) {
            console.error(formattedMessage.trim());
        }
        await this.writeToFile(formattedMessage);
    }

    async debug(message, context = {}) {
        if (isDev) {
            const formattedMessage = this.formatLogMessage('DEBUG', message, context);
            console.debug(formattedMessage.trim());
            await this.writeToFile(formattedMessage);
        }
    }

    // Логирование операций с монтированием
    async logMount(bookmark, mountName, success, error = null) {
        const context = {
            bookmarkName: bookmark.$name,
            mountName,
            success
        };
        if (error) {
            context.error = error.message;
        }
        await this.info(
            `Mount operation ${success ? 'succeeded' : 'failed'} for ${bookmark.$name}`,
            context
        );
    }

    // Логирование операций с синхронизацией
    async logSync(bookmark, syncName, operation, success, error = null) {
        const context = {
            bookmarkName: bookmark.$name,
            syncName,
            operation,
            success
        };
        if (error) {
            context.error = error.message;
        }
        await this.info(
            `Sync ${operation} ${success ? 'succeeded' : 'failed'} for ${bookmark.$name}`,
            context
        );
    }

    // Логирование изменений конфигурации
    async logConfigChange(type, details) {
        const context = {
            type,
            ...details
        };
        await this.info('Configuration changed', context);
    }

    // Логирование операций с API
    async logApiOperation(endpoint, method, success, error = null) {
        const context = {
            endpoint,
            method,
            success
        };
        if (error) {
            context.error = error.message;
        }
        await this.debug('API operation', context);
    }
}

// Создаем и экспортируем единственный экземпляр сервиса
const logger = new LoggingService();
module.exports = logger;