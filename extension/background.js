// Background script - central controller for the extension
// Handles messages from popup/content scripts and communicates with Flask backend

const SERVER_URL = "http://localhost:5000";

// Cache for video info - keyed by video ID
const videoInfoCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

// ==================== QUEUE MANAGEMENT ====================
let downloadQueue = [];
let isProcessingQueue = false;

// Load queue from storage on startup
async function initializeQueue() {
    try {
        const data = await browser.storage.local.get("downloadQueue");
        if (data.downloadQueue && Array.isArray(data.downloadQueue)) {
            // Reset any "downloading" items to "pending" (browser may have restarted)
            downloadQueue = data.downloadQueue.map(item => ({
                ...item,
                status: item.status === "downloading" ? "pending" : item.status
            }));
            await saveQueue();
            console.log("Queue loaded:", downloadQueue.length, "items");
            // Start processing if there are pending items
            processQueue();
        }
    } catch (e) {
        console.error("Error loading queue:", e);
    }
}

// Save queue to storage
async function saveQueue() {
    try {
        await browser.storage.local.set({ downloadQueue: downloadQueue });
    } catch (e) {
        console.error("Error saving queue:", e);
    }
}

// Add item to queue
async function addToQueue(item) {
    // Check for duplicates (same video pending or downloading)
    const exists = downloadQueue.some(q => 
        q.videoId === item.videoId && 
        (q.status === "pending" || q.status === "downloading")
    );
    
    if (exists) {
        return { success: false, error: "Video already in queue" };
    }
    
    downloadQueue.push(item);
    await saveQueue();
    
    // Start processing if not already
    processQueue();
    
    return { success: true, queueLength: downloadQueue.length };
}

// Remove item from queue
async function removeFromQueue(id) {
    const index = downloadQueue.findIndex(item => item.id === id);
    if (index !== -1 && downloadQueue[index].status !== "downloading") {
        downloadQueue.splice(index, 1);
        await saveQueue();
        return { success: true };
    }
    return { success: false, error: "Cannot remove item" };
}

// Clear completed/failed items
async function clearCompletedFromQueue() {
    downloadQueue = downloadQueue.filter(item => 
        item.status === "pending" || item.status === "downloading"
    );
    await saveQueue();
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
    if (isProcessingQueue) return;
    
    const nextItem = downloadQueue.find(item => item.status === "pending");
    if (!nextItem) return;
    
    isProcessingQueue = true;
    nextItem.status = "downloading";
    await saveQueue();
    
    // Notify popup of queue update
    notifyPopup();
    
    console.log("Processing queue item:", nextItem.title);
    
    try {
        const result = await handleDownload({
            url: nextItem.url,
            quality: nextItem.quality,
            videoTitle: nextItem.title,
            channelName: nextItem.channel,
            subtitles: nextItem.subtitles
        });
        
        if (result && result.success) {
            nextItem.status = "completed";
            console.log("Queue item completed:", nextItem.title);
        } else {
            nextItem.status = "failed";
            nextItem.error = (result && result.error) || "Download failed";
            console.error("Queue item failed:", nextItem.title, nextItem.error);
        }
    } catch (error) {
        console.error("Queue download error:", error);
        nextItem.status = "failed";
        nextItem.error = error.message || "Unknown error";
    }
    
    await saveQueue();
    isProcessingQueue = false;
    
    // Notify popup of queue update
    notifyPopup();
    
    // Process next item after a short delay
    setTimeout(() => processQueue(), 500);
}

// Notify popup of queue changes
function notifyPopup() {
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
    console.log("Background received message:", message);

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

    return false;
});

// Listen for tab updates to prefetch video info
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Only act when the page has finished loading
    if (changeInfo.status === "complete" && tab.url) {
        if (tab.url.includes("youtube.com/watch")) {
            const videoId = extractVideoId(tab.url);
            if (videoId && !getCachedInfo(videoId)) {
                console.log("Prefetching info for video:", videoId);
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
                console.log("Prefetching info on tab switch:", videoId);
                prefetchVideoInfo(tab.url, videoId);
            }
        }
    } catch (e) {
        // Tab might not exist anymore
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
        console.log("Cache hit for video:", videoId);
        return cached.data;
    }
    if (cached && !cached.fetching) {
        // Expired, remove it
        videoInfoCache.delete(videoId);
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
            return;
        }
    }

    // Mark as fetching to prevent duplicate requests
    videoInfoCache.set(videoId, { fetching: true, timestamp: Date.now() });

    try {
        const cleanUrl = cleanYouTubeUrl(url);
        console.log("Prefetching from server:", cleanUrl);
        
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
                console.log("Cached info for video:", videoId, data.title);
            } else {
                // Remove failed fetch marker
                videoInfoCache.delete(videoId);
            }
        } else {
            videoInfoCache.delete(videoId);
        }
    } catch (error) {
        console.error("Prefetch error:", error);
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
        const checkDownload = async () => {
            try {
                const [download] = await browser.downloads.search({ id: downloadId });
                if (!download) {
                    resolve({ success: false, error: "Download not found" });
                    return;
                }
                
                if (download.state === "complete") {
                    console.log("Download completed:", download.filename);
                    resolve({ success: true });
                } else if (download.state === "interrupted") {
                    console.log("Download interrupted:", download.error);
                    resolve({ success: false, error: download.error || "Download interrupted" });
                } else {
                    // Still in progress, check again
                    setTimeout(checkDownload, 1000);
                }
            } catch (e) {
                console.error("Error checking download:", e);
                resolve({ success: false, error: e.message });
            }
        };
        
        // Start checking
        checkDownload();
    });
}

// Handle download request via Flask backend
async function handleDownload(message) {
    const { url, quality, videoTitle, channelName, subtitles } = message;
    
    // Clean the URL first
    const cleanUrl = cleanYouTubeUrl(url);
    console.log("Clean URL:", cleanUrl);
    console.log("Quality data:", quality);

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
        console.log("Checking server health...");
        const healthCheck = await fetch(`${SERVER_URL}/health`, {
            method: "GET",
            mode: "cors",
        });
        
        if (!healthCheck.ok) {
            throw new Error("Flask server is not responding. Please start it: python backend/server.py");
        }
        
        const healthData = await healthCheck.json();
        console.log("Server health:", healthData);

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
        
        console.log("Starting download from:", downloadUrl);

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
        
        console.log("Download started with ID:", downloadId);

        // Wait for download to complete (for queue tracking)
        const downloadResult = await waitForDownloadComplete(downloadId);
        
        if (downloadResult.success) {
            return { success: true, message: "Download completed!" };
        } else {
            return { success: false, error: downloadResult.error || "Download failed" };
        }
    } catch (error) {
        console.error("Download error:", error);
        
        // Provide helpful error messages
        if (error.message.includes("NetworkError") || error.message.includes("fetch") || error.message.includes("Failed to fetch")) {
            throw new Error("Cannot connect to server. Make sure Flask is running: python backend/server.py");
        }
        
        throw error;
    }
}

// Handle playlist download request
async function handlePlaylistDownload(message) {
    const { url, quality, playlistTitle, subtitles } = message;
    
    console.log("Starting playlist download:", playlistTitle);
    console.log("Quality:", quality);

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
        console.log("Checking server health...");
        const healthCheck = await fetch(`${SERVER_URL}/health`, {
            method: "GET",
            mode: "cors",
        });
        
        if (!healthCheck.ok) {
            throw new Error("Flask server is not responding. Please start it: python backend/server.py");
        }

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
        
        console.log("Starting playlist download from:", downloadUrl);

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
        
        console.log("Playlist download started with ID:", downloadId);

        return { success: true, message: "Playlist download started! Videos will be saved as a ZIP file." };
    } catch (error) {
        console.error("Playlist download error:", error);
        
        if (error.message.includes("NetworkError") || error.message.includes("fetch") || error.message.includes("Failed to fetch")) {
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
        console.log(`Download ${delta.id} state: ${delta.state.current}`);
        if (delta.state.current === "complete") {
            console.log("Download completed successfully!");
        } else if (delta.state.current === "interrupted") {
            console.error("Download was interrupted");
        }
    }
    if (delta.error) {
        console.error(`Download ${delta.id} error:`, delta.error.current);
    }
});

console.log("Background script loaded");
console.log("Flask server URL:", SERVER_URL);
