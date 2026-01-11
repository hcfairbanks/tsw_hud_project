'use strict';
const fs = require('fs');
const path = require('path');

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB limit

// Get the directory where the exe is running from (works for both dev and compiled)
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

/**
 * Parse JSON body from request
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

/**
 * Parse raw body as buffer
 */
function parseRawBody(req, maxSize = MAX_UPLOAD_SIZE) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                req.destroy();
                reject(new Error('Upload too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/**
 * Parse multipart form data
 */
async function parseMultipart(req) {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
        throw new Error('No boundary found in content-type');
    }
    
    const boundary = boundaryMatch[1];
    const body = await parseRawBody(req);
    
    const parts = [];
    const boundaryBuffer = Buffer.from('--' + boundary);
    const endBoundaryBuffer = Buffer.from('--' + boundary + '--');
    
    let start = body.indexOf(boundaryBuffer) + boundaryBuffer.length + 2; // skip boundary + CRLF
    
    while (start < body.length) {
        const nextBoundary = body.indexOf(boundaryBuffer, start);
        if (nextBoundary === -1) break;
        
        const partData = body.slice(start, nextBoundary - 2); // -2 for CRLF before boundary
        
        // Split headers from content
        const headerEnd = partData.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
            start = nextBoundary + boundaryBuffer.length + 2;
            continue;
        }
        
        const headers = partData.slice(0, headerEnd).toString();
        const content = partData.slice(headerEnd + 4);
        
        // Parse Content-Disposition
        const dispositionMatch = headers.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/);
        if (dispositionMatch) {
            parts.push({
                name: dispositionMatch[1],
                filename: dispositionMatch[2] || null,
                data: content
            });
        }
        
        // Check if this is the end boundary
        if (body.indexOf(endBoundaryBuffer, nextBoundary) === nextBoundary) {
            break;
        }
        
        start = nextBoundary + boundaryBuffer.length + 2;
    }
    
    return parts;
}

/**
 * Send JSON response
 */
function sendJson(res, data, statusCode = 200) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * Serve static file
 */
function serveFile(res, filePath, contentType) {
    // Try appDir first (for compiled exe), then project root (for dev)
    let fullPath = path.join(appDir, 'views', filePath);
    if (!fs.existsSync(fullPath)) {
        fullPath = path.join(__dirname, '..', 'views', filePath);
    }
    if (fs.existsSync(fullPath)) {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(fs.readFileSync(fullPath));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
}

module.exports = {
    parseBody,
    parseRawBody,
    parseMultipart,
    sendJson,
    serveFile,
    MAX_UPLOAD_SIZE
};
