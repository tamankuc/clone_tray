const { exec, execSync } = require('child_process');
const settings = require('../../settings');
const { RcloneBinaryBundled } = require('./constants');

const getRcloneBinary = function() {
  return settings.get('rclone_use_bundled') ? RcloneBinaryBundled : 'rclone';
};

const executeCliCommand = async function(endpoint, params) {
  console.log('Falling back to CLI command for endpoint:', endpoint);
  const rcloneBinary = getRcloneBinary();

  try {
    switch (endpoint) {
      case 'core/version': {
        const version = execSync(`${rcloneBinary} version`).toString();
        return { version: version.split('\n')[0] };
      }
      // Add other CLI commands as needed
      default:
        throw new Error(`Unsupported CLI fallback for endpoint: ${endpoint}`);
    }
  } catch (error) {
    console.error('CLI execution failed:', error);
    throw error;
  }
};

module.exports = {
  getRcloneBinary,
  executeCliCommand
};