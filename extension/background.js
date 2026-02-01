// Background script - central controller for the extension
// Handles messages from popup/content scripts and communicates with Flask backend

const SERVER_URL = "http://localhost:5000";

// Cache for video info - keyed by video ID
const videoInfoCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

// Listen for messages from popup or content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Background received message:", message);

    if (message.type === "DOWNLOAD_VIDEO") {
        handleDownload(message)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep the message channel open for async response
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

// Handle download request via Flask backend
async function handleDownload(message) {
    const { url, quality, videoTitle, channelName } = message;
    
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

        return { success: true, message: "Download started! Check your downloads." };
    } catch (error) {
        console.error("Download error:", error);
        
        // Provide helpful error messages
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
