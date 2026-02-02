// Background script - central controller for the extension
// Handles messages from popup/content scripts and communicates with Flask backend

const SERVER_URL = "http://localhost:5000";

// ==================== LOGGING UTILITIES ====================
const LOG_PREFIX = "[BG]";
const LOG_COLORS = {
    info: "color: #2196F3",
    success: "color: #4CAF50",
    warn: "color: #FF9800",
    error: "color: #F44336",
    queue: "color: #9C27B0",
    download: "color: #00BCD4"
};

// File logging configuration
const MAX_LOG_ENTRIES = 1000; // Keep last 1000 entries
let logBuffer = [];
let logSaveTimeout = null;

// Save logs to storage (debounced)
async function saveLogsToStorage() {
    try {
        await browser.storage.local.set({ extensionLogs: logBuffer });
    } catch (e) {
        console.error("Failed to save logs:", e);
    }
}

// Debounced save - waits 1 second after last log before saving
function scheduleSaveLogs() {
    if (logSaveTimeout) {
        clearTimeout(logSaveTimeout);
    }
    logSaveTimeout = setTimeout(saveLogsToStorage, 1000);
}

// Load existing logs on startup
async function loadLogsFromStorage() {
    try {
        const data = await browser.storage.local.get("extensionLogs");
        if (data.extensionLogs && Array.isArray(data.extensionLogs)) {
            logBuffer = data.extensionLogs;
            console.log(`[BG] Loaded ${logBuffer.length} existing log entries`);
        }
    } catch (e) {
        console.error("Failed to load logs:", e);
    }
}

// Initialize logs
loadLogsFromStorage();

function log(type, message, ...data) {
    const now = new Date();
    const timestamp = now.toISOString().slice(11, 23);
    const fullTimestamp = now.toISOString();
    const style = LOG_COLORS[type] || "color: inherit";
    
    // Console log
    if (data.length > 0) {
        console.log(`%c${LOG_PREFIX} [${timestamp}] [${type.toUpperCase()}] ${message}`, style, ...data);
    } else {
        console.log(`%c${LOG_PREFIX} [${timestamp}] [${type.toUpperCase()}] ${message}`, style);
    }
    
    // File log entry
    const logEntry = {
        timestamp: fullTimestamp,
        source: "background",
        type: type.toUpperCase(),
        message: message,
        data: data.length > 0 ? JSON.stringify(data, null, 0) : null
    };
    
    logBuffer.push(logEntry);
    
    // Trim if exceeds max entries
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
    }
    
    // Schedule save
    scheduleSaveLogs();
}

function logInfo(message, ...data) { log("info", message, ...data); }
function logSuccess(message, ...data) { log("success", message, ...data); }
function logWarn(message, ...data) { log("warn", message, ...data); }
function logError(message, ...data) { log("error", message, ...data); }
function logQueue(message, ...data) { log("queue", message, ...data); }
function logDownload(message, ...data) { log("download", message, ...data); }

// Get all logs (for export)
function getLogs() {
    return logBuffer;
}

// Clear all logs
async function clearLogs() {
    logBuffer = [];
    await browser.storage.local.remove("extensionLogs");
    return { success: true };
}

// Export logs as downloadable file
async function exportLogs() {
    const logText = logBuffer.map(entry => {
        const dataStr = entry.data ? ` | ${entry.data}` : "";
        return `[${entry.timestamp}] [${entry.source.toUpperCase()}] [${entry.type}] ${entry.message}${dataStr}`;
    }).join("\n");
    
    const blob = new Blob([logText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const filename = `yt_downloader_logs_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
    
    try {
        await browser.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        });
        return { success: true, filename };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Cache for video info - keyed by video ID
const videoInfoCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

// ==================== QUEUE MANAGEMENT ====================
let downloadQueue = [];
let isProcessingQueue = false;

// Load queue from storage on startup
async function initializeQueue() {
    logQueue("Initializing queue from storage...");
    try {
        const data = await browser.storage.local.get("downloadQueue");
        if (data.downloadQueue && Array.isArray(data.downloadQueue)) {
            const resetCount = data.downloadQueue.filter(i => i.status === "downloading").length;
            // Reset any "downloading" items to "pending" (browser may have restarted)
            downloadQueue = data.downloadQueue.map(item => ({
                ...item,
                status: item.status === "downloading" ? "pending" : item.status
            }));
            await saveQueue();
            logQueue(`Queue loaded: ${downloadQueue.length} items`, {
                pending: downloadQueue.filter(i => i.status === "pending").length,
                completed: downloadQueue.filter(i => i.status === "completed").length,
                failed: downloadQueue.filter(i => i.status === "failed").length,
                resetFromDownloading: resetCount
            });
            // Start processing if there are pending items
            processQueue();
        } else {
            logQueue("No existing queue found in storage");
        }
    } catch (e) {
        logError("Error loading queue:", e);
    }
}

// Save queue to storage
async function saveQueue() {
    try {
        await browser.storage.local.set({ downloadQueue: downloadQueue });
        logQueue(`Queue saved (${downloadQueue.length} items)`);
    } catch (e) {
        logError("Error saving queue:", e);
    }
}

// Add item to queue
async function addToQueue(item) {
    logQueue("Add to queue request:", { id: item.id, title: item.title, videoId: item.videoId, quality: item.qualityLabel });
    
    // Check for duplicates (same video pending or downloading)
    const exists = downloadQueue.some(q => 
        q.videoId === item.videoId && 
        (q.status === "pending" || q.status === "downloading")
    );
    
    if (exists) {
        logWarn("Duplicate video rejected:", item.videoId);
        return { success: false, error: "Video already in queue" };
    }
    
    downloadQueue.push(item);
    await saveQueue();
    
    logSuccess(`Added to queue: "${item.title}" (${item.qualityLabel})`, { queueLength: downloadQueue.length });
    
    // Start processing if not already
    processQueue();
    
    return { success: true, queueLength: downloadQueue.length };
}

// Remove item from queue
async function removeFromQueue(id) {
    logQueue("Remove from queue request:", { id });
    const index = downloadQueue.findIndex(item => item.id === id);
    if (index !== -1) {
        const item = downloadQueue[index];
        if (item.status === "downloading") {
            logWarn("Cannot remove item - currently downloading:", { id, title: item.title });
            return { success: false, error: "Cannot remove item while downloading" };
        }
        downloadQueue.splice(index, 1);
        await saveQueue();
        logSuccess(`Removed from queue: "${item.title}"`, { id });
        return { success: true };
    }
    logWarn("Remove failed - item not found:", { id });
    return { success: false, error: "Item not found" };
}

// Clear completed/failed items
async function clearCompletedFromQueue() {
    const beforeCount = downloadQueue.length;
    const clearedItems = downloadQueue.filter(item => 
        item.status === "completed" || item.status === "failed"
    );
    downloadQueue = downloadQueue.filter(item => 
        item.status === "pending" || item.status === "downloading"
    );
    await saveQueue();
    logQueue(`Cleared ${clearedItems.length} completed/failed items`, {
        cleared: clearedItems.map(i => ({ title: i.title, status: i.status })),
        remaining: downloadQueue.length
    });
    return { success: true, queueLength: downloadQueue.length };
}

// Get current queue state
function getQueueState() {
    return {
        queue: downloadQueue,
        isProcessing: isProcessingQueue
    };
}

// Process the download queue
async function processQueue() {
    if (isProcessingQueue) {
        logQueue("Queue already processing, skipping");
        return;
    }
    
    const pendingItems = downloadQueue.filter(item => item.status === "pending");
    const nextItem = pendingItems[0];
    
    if (!nextItem) {
        logQueue("No pending items in queue");
        return;
    }
    
    isProcessingQueue = true;
    nextItem.status = "downloading";
    await saveQueue();
    
    // Notify popup of queue update
    notifyPopup();
    
    logDownload(`▶ Starting queue download: "${nextItem.title}"`, {
        id: nextItem.id,
        quality: nextItem.qualityLabel,
        pendingRemaining: pendingItems.length - 1
    });
    
    const startTime = Date.now();
    
    try {
        const result = await handleDownload({
            url: nextItem.url,
            quality: nextItem.quality,
            videoTitle: nextItem.title,
            channelName: nextItem.channel,
            subtitles: nextItem.subtitles
        });
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (result && result.success) {
            nextItem.status = "completed";
            logSuccess(`✓ Queue item completed: "${nextItem.title}" (${elapsed}s)`);
        } else {
            nextItem.status = "failed";
            nextItem.error = (result && result.error) || "Download failed";
            logError(`✗ Queue item failed: "${nextItem.title}"`, { error: nextItem.error, elapsed: `${elapsed}s` });
        }
    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        logError(`✗ Queue download exception: "${nextItem.title}"`, { error: error.message, elapsed: `${elapsed}s`, stack: error.stack });
        nextItem.status = "failed";
        nextItem.error = error.message || "Unknown error";
    }
    
    await saveQueue();
    isProcessingQueue = false;
    
    // Notify popup of queue update
    notifyPopup();
    
    // Process next item after a short delay
    const remainingPending = downloadQueue.filter(i => i.status === "pending").length;
    if (remainingPending > 0) {
        logQueue(`Scheduling next download in 500ms (${remainingPending} pending)`);
    }
    setTimeout(() => processQueue(), 500);
}

// Notify popup of queue changes
function notifyPopup() {
    const stats = {
        total: downloadQueue.length,
        pending: downloadQueue.filter(i => i.status === "pending").length,
        downloading: downloadQueue.filter(i => i.status === "downloading").length,
        completed: downloadQueue.filter(i => i.status === "completed").length,
        failed: downloadQueue.filter(i => i.status === "failed").length
    };
    logQueue("Notifying popup of queue update", stats);
    
    browser.runtime.sendMessage({
        type: "QUEUE_UPDATED",
        queue: downloadQueue,
        isProcessing: isProcessingQueue
    }).catch(() => {
        // Popup might not be open, ignore error
    });
}

// Initialize queue on startup
initializeQueue();

// Listen for messages from popup or content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const source = sender.tab ? `Tab ${sender.tab.id}` : "Popup/Extension";
    logInfo(`📩 Message received [${message.type}] from ${source}`, message);

    if (message.type === "DOWNLOAD_VIDEO") {
        handleDownload(message)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep the message channel open for async response
    }

    if (message.type === "DOWNLOAD_PLAYLIST") {
        handlePlaylistDownload(message)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.type === "GET_CACHED_INFO") {
        // Check if we have cached data or if a fetch is in progress
        getCachedInfoAsync(message.videoId)
            .then(cached => sendResponse(cached))
            .catch(() => sendResponse(null));
        return true; // Keep channel open for async response
    }

    if (message.type === "PREFETCH_INFO") {
        // Trigger prefetch without waiting
        prefetchVideoInfo(message.url, message.videoId);
        sendResponse({ acknowledged: true });
        return false;
    }

    // ==================== QUEUE MESSAGES ====================
    if (message.type === "ADD_TO_QUEUE") {
        addToQueue(message.item)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.type === "REMOVE_FROM_QUEUE") {
        removeFromQueue(message.id)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.type === "CLEAR_COMPLETED") {
        clearCompletedFromQueue()
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.type === "GET_QUEUE") {
        sendResponse(getQueueState());
        return false;
    }

    if (message.type === "START_QUEUE") {
        processQueue();
        sendResponse({ success: true });
        return false;
    }

    // ==================== LOG MESSAGES ====================
    if (message.type === "GET_LOGS") {
        sendResponse({ success: true, logs: getLogs() });
        return false;
    }

    if (message.type === "CLEAR_LOGS") {
        clearLogs()
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.type === "EXPORT_LOGS") {
        exportLogs()
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.type === "ADD_LOG") {
        // Allow popup to add logs to the shared log buffer
        const entry = {
            timestamp: new Date().toISOString(),
            source: message.source || "popup",
            type: message.logType || "INFO",
            message: message.message,
            data: message.data ? JSON.stringify(message.data, null, 0) : null
        };
        logBuffer.push(entry);
        if (logBuffer.length > MAX_LOG_ENTRIES) {
            logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
        }
        scheduleSaveLogs();
        sendResponse({ success: true });
        return false;
    }

    return false;
});

// Listen for tab updates to prefetch video info
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Only act when the page has finished loading
    if (changeInfo.status === "complete" && tab.url) {
        if (tab.url.includes("youtube.com/watch")) {
            const videoId = extractVideoId(tab.url);
            if (videoId && !getCachedInfo(videoId)) {
                logInfo(`Tab updated - triggering prefetch for: ${videoId}`);
                prefetchVideoInfo(tab.url, videoId);
            }
        }
    }
});

// Also listen for tab activation (switching tabs)
browser.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await browser.tabs.get(activeInfo.tabId);
        if (tab.url && tab.url.includes("youtube.com/watch")) {
            const videoId = extractVideoId(tab.url);
            if (videoId && !getCachedInfo(videoId)) {
                logInfo(`Tab activated - triggering prefetch for: ${videoId}`);
                prefetchVideoInfo(tab.url, videoId);
            }
        }
    } catch (e) {
        // Tab might not exist anymore
        logWarn("Tab activation error (tab may not exist):", e.message);
    }
});

// Extract video ID from YouTube URL
function extractVideoId(url) {
    try {
        const parsed = new URL(url);
        return parsed.searchParams.get("v");
    } catch (e) {
        return null;
    }
}

// Clean URL to remove playlist and other parameters
function cleanYouTubeUrl(url) {
    try {
        const parsed = new URL(url);
        const videoId = parsed.searchParams.get("v");
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
    } catch (e) {
        console.error("URL parsing error:", e);
    }
    return url;
}

// Get cached video info (synchronous - returns immediately if available)
function getCachedInfo(videoId) {
    const cached = videoInfoCache.get(videoId);
    if (cached && !cached.fetching && (Date.now() - cached.timestamp < CACHE_TTL)) {
        logInfo(`Cache HIT for video: ${videoId}`);
        return cached.data;
    }
    if (cached && cached.fetching) {
        logInfo(`Cache PENDING for video: ${videoId}`);
    } else if (cached && !cached.fetching) {
        // Expired, remove it
        logInfo(`Cache EXPIRED for video: ${videoId}`);
        videoInfoCache.delete(videoId);
    } else {
        logInfo(`Cache MISS for video: ${videoId}`);
    }
    return null;
}

// Get cached info, waiting for in-progress fetches (up to 10 seconds)
async function getCachedInfoAsync(videoId) {
    // First check if we have cached data
    const immediate = getCachedInfo(videoId);
    if (immediate) return immediate;
    
    // Check if a fetch is in progress
    const cached = videoInfoCache.get(videoId);
    if (cached && cached.fetching) {
        console.log("Waiting for in-progress fetch for:", videoId);
        // Wait for the fetch to complete (poll every 200ms, max 10 seconds)
        for (let i = 0; i < 50; i++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            const result = getCachedInfo(videoId);
            if (result) return result;
            // Check if fetch failed (entry removed)
            if (!videoInfoCache.has(videoId)) break;
        }
    }
    
    return null;
}

// Prefetch video info from server and cache it
async function prefetchVideoInfo(url, videoId) {
    // Don't prefetch if already cached or currently fetching
    if (videoInfoCache.has(videoId)) {
        const cached = videoInfoCache.get(videoId);
        if (cached.fetching || (Date.now() - cached.timestamp < CACHE_TTL)) {
            logInfo(`Skipping prefetch (already ${cached.fetching ? 'fetching' : 'cached'}): ${videoId}`);
            return;
        }
    }

    // Mark as fetching to prevent duplicate requests
    videoInfoCache.set(videoId, { fetching: true, timestamp: Date.now() });
    logInfo(`Starting prefetch for: ${videoId}`);

    try {
        const cleanUrl = cleanYouTubeUrl(url);
        
        const response = await fetch(`${SERVER_URL}/info?url=${encodeURIComponent(cleanUrl)}`, {
            method: "GET",
            mode: "cors",
        });

        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                videoInfoCache.set(videoId, {
                    data: data,
                    timestamp: Date.now(),
                    fetching: false
                });
                logSuccess(`Prefetch complete: "${data.title}" (${videoId})`, {
                    qualities: data.available_qualities?.length || 0,
                    duration: data.duration
                });
            } else {
                logWarn(`Prefetch returned error for ${videoId}:`, data.error);
                videoInfoCache.delete(videoId);
            }
        } else {
            logError(`Prefetch HTTP error for ${videoId}:`, { status: response.status });
            videoInfoCache.delete(videoId);
        }
    } catch (error) {
        logError(`Prefetch exception for ${videoId}:`, { message: error.message });
        videoInfoCache.delete(videoId);
    }
}

// Sanitize string for use as filename (remove invalid characters)
function sanitizeFilename(name) {
    if (!name) return "";
    // Remove characters not allowed in Windows filenames: \ / : * ? " < > |
    // Also remove other problematic characters
    return name
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// Wait for a download to complete
function waitForDownloadComplete(downloadId) {
    return new Promise((resolve) => {
        let checkCount = 0;
        const checkDownload = async () => {
            checkCount++;
            try {
                const [download] = await browser.downloads.search({ id: downloadId });
                if (!download) {
                    logError(`Download ${downloadId} not found after ${checkCount} checks`);
                    resolve({ success: false, error: "Download not found" });
                    return;
                }
                
                if (download.state === "complete") {
                    logSuccess(`Download ${downloadId} completed: ${download.filename}`);
                    resolve({ success: true });
                } else if (download.state === "interrupted") {
                    logError(`Download ${downloadId} interrupted:`, download.error);
                    resolve({ success: false, error: download.error || "Download interrupted" });
                } else {
                    // Still in progress, check again
                    if (checkCount % 10 === 0) {
                        logDownload(`Download ${downloadId} still in progress (check #${checkCount})...`);
                    }
                    setTimeout(checkDownload, 1000);
                }
            } catch (e) {
                logError(`Error checking download ${downloadId}:`, e.message);
                resolve({ success: false, error: e.message });
            }
        };
        
        logDownload(`Waiting for download ${downloadId} to complete...`);
        checkDownload();
    });
}

// Handle download request via Flask backend
async function handleDownload(message) {
    const { url, quality, videoTitle, channelName, subtitles } = message;
    
    // Clean the URL first
    const cleanUrl = cleanYouTubeUrl(url);
    logDownload("Processing download request", {
        title: videoTitle,
        channel: channelName,
        url: cleanUrl,
        quality: quality,
        subtitles: subtitles
    });

    // Build yt-dlp format string based on quality selection
    let format;
    let resolution = "";
    let codec = "";
    
    if (typeof quality === "object") {
        // New format with height and codec info
        if (quality.isAudio) {
            format = "bestaudio/best";
            resolution = "";
            codec = "mp3";
        } else if (quality.height) {
            // Request specific height
            format = `bestvideo[height<=${quality.height}]+bestaudio/best[height<=${quality.height}]/best`;
            resolution = `${quality.height}p`;
            codec = quality.codec || "";
        } else {
            format = "best";
        }
    } else {
        // Legacy format (string)
        switch (quality) {
            case "best":
                format = "best";
                break;
            case "audio":
                format = "bestaudio/best";
                break;
            default:
                format = `best[height<=${quality}]/best`;
                resolution = `${quality}p`;
        }
    }

    try {
        // First check if server is running
        logInfo("Checking server health...");
        const healthCheck = await fetch(`${SERVER_URL}/health`, {
            method: "GET",
            mode: "cors",
        });
        
        if (!healthCheck.ok) {
            logError("Server health check failed", { status: healthCheck.status });
            throw new Error("Flask server is not responding. Please start it: python backend/server.py");
        }
        
        const healthData = await healthCheck.json();
        logSuccess("Server health OK", healthData);

        // Build download URL with all metadata
        const params = new URLSearchParams({
            url: cleanUrl,
            format: format,
            title: videoTitle || "",
            channel: channelName || "",
            resolution: resolution,
            codec: codec
        });
        
        // Add subtitles parameter if requested
        if (subtitles) {
            params.append("subtitles", subtitles);
        }
        
        const downloadUrl = `${SERVER_URL}/download?${params.toString()}`;
        
        logDownload("Starting download", { url: downloadUrl, filename: filename });

        // Build filename: "Title - Channel (Resolution, Codec).mp4"
        let filename = sanitizeFilename(videoTitle || "video");
        if (channelName) {
            filename += " - " + sanitizeFilename(channelName);
        }
        if (resolution && codec) {
            filename += ` (${resolution}, ${codec})`;
        } else if (resolution) {
            filename += ` (${resolution})`;
        }
        filename += ".mp4";

        // Trigger browser download - streams directly from Flask server
        // saveAs: false uses browser's default download location without prompting
        const downloadId = await browser.downloads.download({
            url: downloadUrl,
            filename: filename,
            saveAs: false
        });
        
        logDownload(`Browser download initiated (ID: ${downloadId})`, { filename });

        // Wait for download to complete (for queue tracking)
        const downloadResult = await waitForDownloadComplete(downloadId);
        
        if (downloadResult.success) {
            return { success: true, message: "Download completed!" };
        } else {
            return { success: false, error: downloadResult.error || "Download failed" };
        }
    } catch (error) {
        logError("Download error", { message: error.message, stack: error.stack });
        
        // Provide helpful error messages
        if (error.message.includes("NetworkError") || error.message.includes("fetch") || error.message.includes("Failed to fetch")) {
            const networkError = new Error("Cannot connect to server. Make sure Flask is running: python backend/server.py");
            logError("Network error - server unreachable");
            throw networkError;
        }
        
        throw error;
    }
}

// Handle playlist download request
async function handlePlaylistDownload(message) {
    const { url, quality, playlistTitle, subtitles } = message;
    
    logDownload("Starting playlist download", {
        title: playlistTitle,
        url: url,
        quality: quality,
        subtitles: subtitles
    });

    // Build yt-dlp format string based on quality selection
    let format;
    let resolution = "";
    let codec = "";
    
    if (typeof quality === "object") {
        if (quality.isAudio) {
            format = "bestaudio/best";
            resolution = "";
            codec = "mp3";
        } else if (quality.height) {
            format = `bestvideo[height<=${quality.height}]+bestaudio/best[height<=${quality.height}]/best`;
            resolution = `${quality.height}p`;
            codec = quality.codec || "";
        } else {
            format = "best";
        }
    } else {
        switch (quality) {
            case "best":
                format = "best";
                break;
            case "audio":
                format = "bestaudio/best";
                break;
            default:
                format = `best[height<=${quality}]/best`;
                resolution = `${quality}p`;
        }
    }

    try {
        // Check if server is running
        logInfo("Checking server health for playlist download...");
        const healthCheck = await fetch(`${SERVER_URL}/health`, {
            method: "GET",
            mode: "cors",
        });
        
        if (!healthCheck.ok) {
            logError("Server health check failed for playlist", { status: healthCheck.status });
            throw new Error("Flask server is not responding. Please start it: python backend/server.py");
        }
        logSuccess("Server health OK for playlist download");

        // Build download URL for playlist
        const params = new URLSearchParams({
            url: url,
            format: format,
            playlist_title: playlistTitle || "playlist",
            resolution: resolution,
            codec: codec
        });
        
        if (subtitles) {
            params.append("subtitles", subtitles);
        }
        
        const downloadUrl = `${SERVER_URL}/download-playlist?${params.toString()}`;
        
        logDownload("Starting playlist download", { url: downloadUrl, filename: filename });

        // Build filename for ZIP
        let filename = sanitizeFilename(playlistTitle || "playlist");
        if (resolution) {
            filename += ` (${resolution})`;
        }
        filename += ".zip";

        // Trigger browser download - streams directly from Flask server
        const downloadId = await browser.downloads.download({
            url: downloadUrl,
            filename: filename,
            saveAs: false
        });
        
        logDownload(`Playlist download initiated (ID: ${downloadId})`, { filename });

        return { success: true, message: "Playlist download started! Videos will be saved as a ZIP file." };
    } catch (error) {
        logError("Playlist download error", { message: error.message, stack: error.stack });
        
        if (error.message.includes("NetworkError") || error.message.includes("fetch") || error.message.includes("Failed to fetch")) {
            logError("Network error - server unreachable for playlist");
            throw new Error("Cannot connect to server. Make sure Flask is running: python backend/server.py");
        }
        
        throw error;
    }
}

// Optional: Listen for extension install/update
browser.runtime.onInstalled.addListener((details) => {
    console.log("Extension installed/updated:", details.reason);
});

// Monitor download progress
browser.downloads.onChanged.addListener((delta) => {
    if (delta.state) {
        const state = delta.state.current;
        if (state === "complete") {
            logSuccess(`Download ${delta.id} completed successfully!`);
        } else if (state === "interrupted") {
            logError(`Download ${delta.id} was interrupted`);
        } else {
            logDownload(`Download ${delta.id} state: ${state}`);
        }
    }
    if (delta.bytesReceived && delta.totalBytes) {
        const percent = ((delta.bytesReceived.current / delta.totalBytes.current) * 100).toFixed(1);
        logDownload(`Download ${delta.id} progress: ${percent}%`);
    }
    if (delta.error) {
        logError(`Download ${delta.id} error:`, delta.error.current);
    }
});

logInfo("═══════════════════════════════════════");
logInfo("Background script loaded");
logInfo(`Flask server URL: ${SERVER_URL}`);
logInfo("═══════════════════════════════════════");
