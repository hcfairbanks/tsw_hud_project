'use strict';
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// App directory
const appDir = __dirname;

// Worker instance - reused for performance
let worker = null;
let workerInitPromise = null;

/**
 * Initialize or get the Tesseract worker
 */
async function getWorker() {
    if (worker) return worker;
    if (workerInitPromise) return workerInitPromise;
    
    workerInitPromise = (async () => {
        console.log('Initializing Tesseract worker...');
        
        worker = await createWorker('eng', 1, {
            logger: m => {
                if (m.status === 'recognizing text') {
                    // Silent during recognition
                }
            }
        });
        
        // Set parameters
        await worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:+-()& []',
            preserve_interword_spaces: '1'
        });
        
        console.log('✓ Tesseract worker ready');
        return worker;
    })();
    
    return workerInitPromise;
}

/**
 * Perform OCR on an image buffer
 */
async function recognizeImage(imageBuffer) {
    const w = await getWorker();
    const result = await w.recognize(imageBuffer);
    return result.data.text;
}

/**
 * Detect and split image into green section (WAIT FOR SERVICE) and blue section (timetable)
 */
async function splitGreenAndBlueSection(imageBuffer) {
    const image = sharp(imageBuffer);
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    
    const rowIsGreen = [];
    
    for (let y = 0; y < height; y++) {
        let greenPixelCount = 0;
        
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * channels;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            
            const isGreenish = (g > r + 20 && g > b) ||
                (g > 100 && g > r && b < g) ||
                (r < 80 && g > 80 && b < 80) ||
                (r < 50 && g < 80 && b < 50);
            
            if (isGreenish) {
                greenPixelCount++;
            }
        }
        
        rowIsGreen.push(greenPixelCount / width > 0.4);
    }
    
    let greenEndRow = 0;
    let consecutiveNonGreen = 0;
    const TRANSITION_THRESHOLD = 5;
    
    for (let y = 0; y < height; y++) {
        if (rowIsGreen[y]) {
            greenEndRow = y;
            consecutiveNonGreen = 0;
        } else {
            consecutiveNonGreen++;
            if (consecutiveNonGreen >= TRANSITION_THRESHOLD && greenEndRow > 0) {
                break;
            }
        }
    }
    
    greenEndRow = Math.min(greenEndRow + 5, height - 1);
    
    if (greenEndRow < 20 || greenEndRow > height - 20) {
        return { greenBuffer: null, blueBuffer: null };
    }
    
    const greenBuffer = await sharp(imageBuffer)
        .extract({ left: 0, top: 0, width: width, height: greenEndRow + 1 })
        .png()
        .toBuffer();
    
    const blueBuffer = await sharp(imageBuffer)
        .extract({ left: 0, top: greenEndRow + 1, width: width, height: height - greenEndRow - 1 })
        .png()
        .toBuffer();
    
    return { greenBuffer, blueBuffer };
}

/**
 * Apply quality preprocessing to a buffer
 * This is the EXACT preprocessing from tsw5_dashboard_hud/extract.js
 * @param {Buffer} inputBuffer - PNG buffer to process
 * @param {boolean} invert - If true, invert for light text on dark backgrounds
 */
async function qualityPreprocessBuffer(inputBuffer, invert = false) {
    const image = sharp(inputBuffer);
    const metadata = await image.metadata();
    
    // Step 1: Upscale 4x with high-quality interpolation
    let processed = image
        .resize(metadata.width * 4, metadata.height * 4, { kernel: 'lanczos3' });
    
    // Step 2: Convert to grayscale
    processed = processed.grayscale();
    
    // Step 3: Normalize contrast (stretch histogram)
    processed = processed.normalize();
    
    // Step 4: Apply sharpening
    processed = processed.sharpen({ sigma: 1.5, m1: 1.5, m2: 0.5 });
    
    // Step 5: Apply median filter to reduce noise
    processed = processed.median(3);
    
    // Step 6: Apply threshold to get pure black and white
    const { data: grayData, info: grayInfo } = await processed.raw().toBuffer({ resolveWithObject: true });
    
    const bwData = Buffer.alloc(grayData.length);
    const THRESHOLD = 128;
    
    for (let i = 0; i < grayData.length; i++) {
        if (invert) {
            // Inverted: light pixels become black (text), dark pixels become white (background)
            bwData[i] = grayData[i] >= THRESHOLD ? 0 : 255;
        } else {
            // Normal: dark pixels become black (text), light pixels become white (background)
            bwData[i] = grayData[i] < THRESHOLD ? 0 : 255;
        }
    }
    
    // Step 7: Thicken text slightly (1px dilation)
    const width = grayInfo.width;
    const height = grayInfo.height;
    const thickenedData = Buffer.from(bwData);
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (bwData[idx] === 0) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                            thickenedData[ny * width + nx] = 0;
                        }
                    }
                }
            }
        }
    }
    
    const qualityImage = sharp(thickenedData, {
        raw: {
            width: grayInfo.width,
            height: grayInfo.height,
            channels: 1
        }
    });
    
    return qualityImage.png().toBuffer();
}

/**
 * Extract timetable data from image buffer
 */
async function extractTimetableFromBuffer(imageBuffer, onProgress) {
    const progressCallback = onProgress || (() => {});
    
    try {
        const { greenBuffer, blueBuffer } = await splitGreenAndBlueSection(imageBuffer);

        let greenText = '';
        let blueText = '';

        if (greenBuffer && blueBuffer) {
            progressCallback({ status: 'Processing green section...', progress: 10 });
            const greenInput = await qualityPreprocessBuffer(greenBuffer, true);
            greenText = await recognizeImage(greenInput);

            progressCallback({ status: 'Processing blue section...', progress: 50 });
            const blueInput = await qualityPreprocessBuffer(blueBuffer, false);
            blueText = await recognizeImage(blueInput);

            return greenText.trim() + '\n' + blueText.trim();
        } else {
            progressCallback({ status: 'Processing image...', progress: 20 });
            const imageInput = await qualityPreprocessBuffer(imageBuffer, false);
            const result = await recognizeImage(imageInput);

            progressCallback({ status: 'Processing inverted...', progress: 60 });
            const invertedInput = await qualityPreprocessBuffer(imageBuffer, true);
            const result2 = await recognizeImage(invertedInput);

            let combinedText = result;
            const allLines = new Set(result.split('\n').map(l => l.trim()).filter(l => l.length > 0));

            const invertedLines = result2.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            invertedLines.forEach(line => {
                if (!allLines.has(line) && line.length > 0) {
                    if (line.includes('WAIT FOR SERVICE')) {
                        combinedText = line + '\n' + combinedText;
                    } else {
                        combinedText += '\n' + line;
                    }
                    allLines.add(line);
                }
            });

            return combinedText;
        }
    } catch (error) {
        console.error('Error processing timetable:', error);
        throw error;
    }
}

/**
 * Extract service name from image buffer
 * Uses normal preprocessing (not inverted) - same as original
 */
async function extractServiceNameFromBuffer(imageBuffer) {
    try {
        const imageInput = await qualityPreprocessBuffer(imageBuffer, false);
        
        // Save debug image
        const debugPath = path.join(appDir, 'ocr_output', 'debug_servicename.png');
        const debugDir = path.dirname(debugPath);
        if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
        }
        fs.writeFileSync(debugPath, imageInput);
        console.log(`  Saved preprocessed service name: ${debugPath}`);
        
        return await recognizeImage(imageInput);
    } catch (error) {
        console.error('Error extracting service name:', error);
        return null;
    }
}

/**
 * Parse timetable text into structured rows
 * Preserves full raw text for each line
 */
function parseTrainTimetable(text) {
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    const rows = [];
    let serviceName = '';

    for (const line of lines) {
        const trimmedLine = line.trim();
        
        // Check if this is an action line
        const isActionLine = trimmedLine.includes('WAIT FOR SERVICE') ||
                            trimmedLine.includes('STOP AT LOCATION') ||
                            trimmedLine.includes('LOAD PASSENGERS') ||
                            trimmedLine.includes('UNLOAD PASSENGERS') ||
                            trimmedLine.includes('GO VIA LOCATION') ||
                            trimmedLine.includes('UNCOUPLE VEHICLES') ||
                            trimmedLine.includes('COUPLE TO FORMATION');

        // If not an action line and we don't have a service name yet, this is the service name
        // The first image is always the service name - just take the whole line
        if (!isActionLine && !serviceName) {
            // Collapse multiple whitespace into single space, keep everything
            serviceName = trimmedLine.replace(/\s{2,}/g, ' ').trim();
            continue;
        }
        
        // Parse each action line - keep the full raw text
        let action = '';
        let details = '';
        let time1 = '';
        let time2 = '';
        
        // Extract times from the line - get unique times only
        const times = trimmedLine.match(/([+-]?\d{1,2}:\d{2}:\d{2})/g) || [];
        // Normalize times: remove +/- prefix, normalize to HH:MM:SS format
        const normalizeTime = (t) => {
            const clean = t.replace(/[+-]/g, '');
            const parts = clean.split(':');
            // Pad hour to 2 digits for consistent comparison
            return parts[0].padStart(2, '0') + ':' + parts[1] + ':' + parts[2];
        };
        const cleanTimes = times.map(normalizeTime);
        // Get unique times (same time may appear twice in the line)
        const uniqueTimes = [...new Set(cleanTimes)];
        if (uniqueTimes.length >= 1) time1 = uniqueTimes[0];
        if (uniqueTimes.length >= 2) time2 = uniqueTimes[1];
        
        if (trimmedLine.includes('WAIT FOR SERVICE')) {
            action = 'WAIT FOR SERVICE';
            // Extract the description part
            const match = trimmedLine.match(/WAIT FOR SERVICE\s+(.+?)(?:\s+[-+]?\d|$)/);
            details = match ? match[1].trim() : trimmedLine.replace('WAIT FOR SERVICE', '').trim();
            // Time goes in time2 column for WAIT FOR SERVICE
            rows.push({ action, details, location: '', platform: '', time1: '', time2: time1, rawLine: trimmedLine });
        } else if (trimmedLine.includes('UNLOAD PASSENGERS')) {
            // Check UNLOAD before LOAD since "UNLOAD PASSENGERS" contains "LOAD PASSENGERS"
            action = 'UNLOAD PASSENGERS';
            const afterAction = trimmedLine.replace('UNLOAD PASSENGERS', '').trim();
            
            // Details = everything up to large whitespace gap
            const parts = afterAction.split(/\s{2,}/);
            details = parts[0] ? parts[0].trim() : afterAction;
            
            const platformMatch = details.match(/(.+?)\s+(?:Platform|Track)\s+(\d+)/i);
            let location = '';
            let platform = '';
            if (platformMatch) {
                location = platformMatch[1].trim();
                platform = platformMatch[2];
            } else {
                location = details.replace(/\s*-\s*\d{1,2}:\d{2}:\d{2}.*$/, '').trim();
            }
            // For UNLOAD PASSENGERS, only use the first time
            rows.push({ action, details, location, platform, time1, time2: '', rawLine: trimmedLine });
        } else if (trimmedLine.includes('LOAD PASSENGERS')) {
            action = 'LOAD PASSENGERS';
            details = '';
            // Only use the first time
            rows.push({ action, details, location: '', platform: '', time1, time2: '', rawLine: trimmedLine });
        } else if (trimmedLine.includes('STOP AT LOCATION')) {
            action = 'STOP AT LOCATION';
            // afterAction is everything after "STOP AT LOCATION"
            const afterAction = trimmedLine.replace('STOP AT LOCATION', '').trim();
            
            // Details = everything up to the repeated +time or large whitespace gap
            // Split on 2+ whitespace chars to separate "Tring Platform 4 - 08:57:30" from "+08:51:30"
            const parts = afterAction.split(/\s{2,}/);
            details = parts[0] ? parts[0].trim() : afterAction;
            
            // Extract location and platform from details
            const platformMatch = details.match(/(.+?)\s+(?:Platform|Track)\s+(\d+)/i);
            let location = '';
            let platform = '';
            if (platformMatch) {
                location = platformMatch[1].trim();
                platform = platformMatch[2];
            } else {
                // No platform found, location is everything before the time
                location = details.replace(/\s*-\s*\d{1,2}:\d{2}:\d{2}.*$/, '').trim();
            }
            // For STOP AT LOCATION, only use the first time (scheduled arrival)
            rows.push({ action, details, location, platform, time1, time2: '', rawLine: trimmedLine });
        } else if (trimmedLine.includes('GO VIA LOCATION')) {
            action = 'GO VIA LOCATION';
            const afterAction = trimmedLine.replace('GO VIA LOCATION', '').trim();

            // Details = everything up to large whitespace gap
            const parts = afterAction.split(/\s{2,}/);
            details = parts[0] ? parts[0].trim() : afterAction;

            // Extract location from details (no platform for GO VIA)
            let location = details.replace(/\s*-\s*\d{1,2}:\d{2}:\d{2}.*$/, '').trim();

            rows.push({ action, details, location, platform: '', time1, time2: '', rawLine: trimmedLine });
        } else if (trimmedLine.includes('UNCOUPLE VEHICLES')) {
            action = 'UNCOUPLE VEHICLES';
            const afterAction = trimmedLine.replace('UNCOUPLE VEHICLES', '').trim();

            // Details = everything up to large whitespace gap
            const parts = afterAction.split(/\s{2,}/);
            details = parts[0] ? parts[0].trim() : afterAction;

            rows.push({ action, details, location: '', platform: '', time1, time2: '', rawLine: trimmedLine });
        } else if (trimmedLine.includes('COUPLE TO FORMATION')) {
            action = 'COUPLE TO FORMATION';
            const afterAction = trimmedLine.replace('COUPLE TO FORMATION', '').trim();

            // Details = everything up to large whitespace gap
            const parts = afterAction.split(/\s{2,}/);
            details = parts[0] ? parts[0].trim() : afterAction;

            rows.push({ action, details, location: '', platform: '', time1, time2: '', rawLine: trimmedLine });
        }
    }

    return { serviceName, rows };
}

/**
 * Process multiple images and extract timetable data
 */
async function processImages(imageBuffers, onProgress) {
    const progressCallback = onProgress || (() => {});
    const results = [];
    let serviceName = '';
    const allRows = [];

    for (let i = 0; i < imageBuffers.length; i++) {
        const buffer = imageBuffers[i];
        const imageNum = i + 1;
        
        progressCallback({
            status: `Processing image ${imageNum} of ${imageBuffers.length}...`,
            progress: Math.round((i / imageBuffers.length) * 100)
        });

        let text = '';

        // First image: extract service name (single pass, not double) and any rows
        if (i === 0) {
            const sn = await extractServiceNameFromBuffer(buffer);
            if (sn) {
                text = sn;
                const parsed = parseTrainTimetable(sn);
                if (parsed.serviceName) {
                    serviceName = parsed.serviceName;
                }
                // Also collect any rows from the first image (e.g., WAIT FOR SERVICE)
                allRows.push(...parsed.rows);
            }
        } else {
            // Other images: extract full timetable data
            text = await extractTimetableFromBuffer(buffer, (p) => {
                progressCallback({
                    status: `Image ${imageNum}: ${p.status}`,
                    progress: Math.round((i / imageBuffers.length) * 100 + (p.progress / imageBuffers.length))
                });
            });

            // Parse the text
            const parsed = parseTrainTimetable(text);
            if (!serviceName && parsed.serviceName) {
                serviceName = parsed.serviceName;
            }
            allRows.push(...parsed.rows);
        }

        results.push({
            imageIndex: i,
            rawText: text
        });
    }

    // Deduplicate rows based on unique combination of action + times + location
    // If times are empty, include location/details to differentiate entries
    const seenKeys = new Set();
    const uniqueRows = [];

    for (const row of allRows) {
        const time1 = (row.time1 || '').trim();
        const time2 = (row.time2 || '').trim();
        const action = (row.action || '').trim();
        const location = (row.location || '').trim();
        const details = (row.details || '').trim();

        // Create unique key - include location/details if no times present
        let uniqueKey;
        if (time1 || time2) {
            // If we have times, use action + times (original logic)
            uniqueKey = `${action}|${time1}|${time2}`;
        } else {
            // If no times, include location/details to differentiate entries
            uniqueKey = `${action}|${location}|${details}`;
        }

        if (!seenKeys.has(uniqueKey)) {
            seenKeys.add(uniqueKey);
            uniqueRows.push(row);
        } else {
            console.log(`OCR: Skipping duplicate entry: ${action} at ${time1 || time2 || location || details}`);
        }
    }

    console.log(`OCR: Deduplicated rows: ${allRows.length} -> ${uniqueRows.length}`);

    // Save raw OCR output
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(appDir, 'ocr_output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const rawOutputPath = path.join(outputDir, `ocr_raw_${timestamp}.txt`);
    let rawContent = '';
    results.forEach((r, i) => {
        rawContent += `${'='.repeat(70)}\nFile: Image ${i + 1}${i === 0 ? ' (Service Name)' : ''}\n${'='.repeat(70)}\n${r.rawText}\n\n`;
    });
    fs.writeFileSync(rawOutputPath, rawContent);
    console.log(`Raw OCR output saved to: ${rawOutputPath}`);

    progressCallback({ status: 'Complete!', progress: 100 });

    // Format rawTexts for the frontend
    const rawTexts = results.map((r, i) => ({
        file: `Image ${i + 1}${i === 0 ? ' (Service Name)' : ''}`,
        text: r.rawText
    }));

    return {
        serviceName: serviceName || 'Unknown Service',
        rows: uniqueRows,
        rawResults: results,
        rawTexts: rawTexts
    };
}

module.exports = {
    processImages,
    extractTimetableFromBuffer,
    extractServiceNameFromBuffer,
    parseTrainTimetable,
    recognizeImage
};

console.log('✓ OCR module loaded');
