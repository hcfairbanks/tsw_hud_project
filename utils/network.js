'use strict';
const { networkInterfaces } = require('os');

/**
 * Gets the internal IP address of this machine
 */
function getInternalIpAddress() {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4;
            if (net.family === familyV4Value && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

module.exports = {
    getInternalIpAddress
};
