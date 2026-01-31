// Background script - central controller for the extension
// Handles messages from popup/content scripts and communicates with Flask backend

const SERVER_URL = "http://localhost:5000";

// Listen for messages from popup or content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Background received message:", message);

    if (message.type === "DOWNLOAD_VIDEO") {
        handleDownload(message)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep the message channel open for async response
    }

    return false;
});

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
        const downloadId = await browser.downloads.download({
            url: downloadUrl,
            filename: filename,
            saveAs: true
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
