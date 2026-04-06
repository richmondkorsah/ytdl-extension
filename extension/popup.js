// ==================== LOGGING UTILITIES ====================
const LOG_PREFIX = "[POPUP]";
const LOG_COLORS = {
    info: "color: #2196F3",
    success: "color: #4CAF50",
    warn: "color: #FF9800",
    error: "color: #F44336",
    queue: "color: #9C27B0",
    ui: "color: #607D8B"
};

// Send log to background script for file storage
async function sendLogToBackground(type, message, data) {
    try {
        // Serialize data safely for debugging
        let serialized = null;
        if (data && data.length > 0) {
            try {
                const val = data.length === 1 ? data[0] : data;
                serialized = typeof val === "string" ? val : JSON.stringify(val, null, 0);
            } catch (e) {
                serialized = String(data);
            }
        }
        await browser.runtime.sendMessage({
            type: "ADD_LOG",
            source: "popup",
            logType: type.toUpperCase(),
            message: message,
            data: serialized
        });
    } catch (e) {
        // Background might not be ready, ignore
    }
}

function log(type, message, ...data) {
    const timestamp = new Date().toISOString().slice(11, 23);
    const style = LOG_COLORS[type] || "color: inherit";
    
    // Console log
    if (data.length > 0) {
        console.log(`%c${LOG_PREFIX} [${timestamp}] [${type.toUpperCase()}] ${message}`, style, ...data);
    } else {
        console.log(`%c${LOG_PREFIX} [${timestamp}] [${type.toUpperCase()}] ${message}`, style);
    }
    
    // Send to background for file storage
    sendLogToBackground(type, message, data);
}

function logInfo(message, ...data) { log("info", message, ...data); }
function logSuccess(message, ...data) { log("success", message, ...data); }
function logWarn(message, ...data) { log("warn", message, ...data); }
function logError(message, ...data) { log("error", message, ...data); }
function logQueue(message, ...data) { log("queue", message, ...data); }
function logUI(message, ...data) { log("ui", message, ...data); }

// Export logs to file (saves to project folder)
async function exportLogs() {
    try {
        logInfo("Exporting logs...");
        const result = await browser.runtime.sendMessage({ type: "EXPORT_LOGS" });
        if (result.success) {
            logSuccess(`Logs exported: ${result.entries} entries saved to ${result.path}`);
        } else {
            logError("Failed to export logs: " + result.error);
        }
        return result;
    } catch (e) {
        logError("Export error: " + e.message);
        return { success: false, error: e.message };
    }
}

// Clear all logs
async function clearAllLogs() {
    try {
        logInfo("Clearing logs...");
        const result = await browser.runtime.sendMessage({ type: "CLEAR_LOGS" });
        if (result.success) {
            logInfo("Logs cleared");
        }
        return result;
    } catch (e) {
        logError("Clear logs error: " + e.message);
        return { success: false, error: e.message };
    }
}

// Get current log count
async function getLogCount() {
    try {
        const result = await browser.runtime.sendMessage({ type: "GET_LOGS" });
        return result.logs ? result.logs.length : 0;
    } catch (e) {
        return 0;
    }
}

logInfo("═══════════════════════════════════════");
logInfo("Popup script initializing...");
logInfo("═══════════════════════════════════════");

const downloadBtn = document.getElementById("download-btn");
const qualitySelect = document.getElementById("quality-select");
const status = document.getElementById("status");
const videoTitleElement = document.getElementById("video-title");
const channelNameElement = document.getElementById("channel-name");
const videoDurationElement = document.getElementById("video-duration");
const videoViewsElement = document.getElementById("video-views");
const videoDurationOverlay = document.getElementById("video-duration-overlay");
const thumbnailImg = document.getElementById("thumbnail-img");
const subtitleCheckbox = document.getElementById("subtitle-checkbox");
const subtitleLang = document.getElementById("subtitle-lang");
const videoStatusText = document.getElementById("video-status-text");
const serverStatusDot = document.getElementById("server-status-dot");
const serverStatusText = document.getElementById("server-status-text");
const storageText = document.getElementById("storage-text");

// Queue elements
const queueBtn = document.getElementById("queue-btn");
const queueOverlay = document.getElementById("queue-overlay");
const closeQueueBtn = document.getElementById("close-queue-btn");
const addToQueueBtn = document.getElementById("add-to-queue-btn");
const queueList = document.getElementById("queue-list");
const queueBadge = document.getElementById("queue-header-badge");
const queueEmpty = document.getElementById("queue-empty");

// History elements
const historyBtn = document.getElementById("history-btn");
const historyOverlay = document.getElementById("history-overlay");
const closeHistoryBtn = document.getElementById("close-history-btn");
const historyList = document.getElementById("history-list");
const historyBadge = document.getElementById("history-badge");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const historyEmpty = document.getElementById("history-empty");
const historyStats = document.getElementById("history-stats");
const retryAllBtn = document.getElementById("retry-all-btn");

// Settings elements
const settingsBtn = document.getElementById("settings-btn");
const settingsOverlay = document.getElementById("settings-overlay");
const closeSettingsBtn = document.getElementById("close-settings-btn");
const exportLogsBtn = document.getElementById("export-logs-btn");
const clearLogsBtn = document.getElementById("clear-logs-btn");
const logCount = document.getElementById("log-count");

// Download queue state
let downloadQueue = [];
let isProcessingQueue = false;
let currentQueueFilter = "all";

// Download history state
let downloadHistory = [];

// Check if queue UI elements exist (only check essential elements)
const queueEnabled = !!(addToQueueBtn && queueList && queueOverlay);
const historyEnabled = !!(historyOverlay && historyList);

logUI("Queue UI elements check:", {
  enabled: queueEnabled,
  addToQueueBtn: !!addToQueueBtn,
  queueList: !!queueList,
  queueOverlay: !!queueOverlay,
  queueBadge: !!queueBadge
});

logUI("History UI elements check:", {
  enabled: historyEnabled,
  historyOverlay: !!historyOverlay,
  historyList: !!historyList
});

// Format bytes to human-readable size
function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return null;
    const units = ['B', 'KB', 'MB', 'GB'];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

// Playlist elements
const playlistContainer = document.getElementById("playlist-container");
const videoContainer = document.getElementById("video-container");
const playlistTitle = document.getElementById("playlist-title");
const playlistCount = document.getElementById("playlist-count");

// Enable/disable subtitle language dropdown based on checkbox
subtitleCheckbox.addEventListener("change", () => {
  subtitleLang.disabled = !subtitleCheckbox.checked;
  const langSection = document.querySelector('.language-section');
  if (langSection) {
    langSection.classList.toggle('visible', subtitleCheckbox.checked);
  }
});

let SERVER_URL = "https://ytdl-extension.onrender.com";

let currentVideoInfo = null;
let currentPlaylistInfo = null;
let isPlaylistMode = false;
let availableQualities = [];

// Extract video ID from URL
function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v");
  } catch (e) {
    return null;
  }
}

// Extract playlist ID from URL
function extractPlaylistId(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("list");
  } catch (e) {
    return null;
  }
}

// Clean YouTube URL to get just the video
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

// Format duration from seconds to MM:SS or HH:MM:SS
function formatDuration(seconds) {
  if (!seconds) return "";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format view count (e.g., 1234567 -> "1.2M views")
function formatViews(views) {
  if (!views) return "";
  const num = parseInt(views);
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M views`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K views`;
  }
  return `${num} views`;
}

async function loadVideoInfo() {
  logInfo("Loading video info...");
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    logInfo("Active tab:", { url: tab.url, id: tab.id });

    // Check if it's a playlist page
    const playlistId = extractPlaylistId(tab.url);
    const videoId = extractVideoId(tab.url);
    
    logInfo("URL analysis:", { playlistId, videoId, isPlaylistPage: tab.url.includes("youtube.com/playlist"), isVideoPage: tab.url.includes("youtube.com/watch") });
    
    // Playlist page (not watching a video in playlist)
    if (tab.url.includes("youtube.com/playlist") && playlistId) {
      logInfo("Detected playlist page, loading playlist info...");
      await loadPlaylistInfo(tab.url, playlistId);
      return;
    }
    
    // Video page (may or may not be part of a playlist)
    if (!tab.url.includes("youtube.com/watch")) {
      logWarn("Not a YouTube video page");
      videoTitleElement.textContent = "Not a YouTube video page";
      downloadBtn.disabled = true;
      return;
    }

    logInfo("Detected video page, loading video info...");

    // Immediately trigger high-priority prefetch in background
    try {
      await browser.runtime.sendMessage({
        type: "IMMEDIATE_PREFETCH",
        url: tab.url
      });
      logInfo("Immediate prefetch triggered for popup");
    } catch (e) {
      logWarn("Failed to trigger immediate prefetch:", e.message);
    }

    // Show video mode UI
    isPlaylistMode = false;
    playlistContainer.style.display = "none";
    videoContainer.style.display = "block";
    downloadBtn.textContent = "Download";

    // Show loading state while we fetch real qualities from the server
    qualitySelect.innerHTML = '<option value="">Fetching qualities...</option>';
    qualitySelect.disabled = true;
    downloadBtn.disabled = true;
    if (addToQueueBtn) addToQueueBtn.disabled = true;

    // Get basic info from content script first (for quick display)
    let contentResponse = null;
    try {
      logInfo("Requesting video info from content script...");
      contentResponse = await browser.tabs.sendMessage(tab.id, {
        type: "GET_VIDEO_INFO"
      });
      logSuccess("Content script response:", contentResponse);
    } catch (e) {
      logWarn("Content script not ready:", e.message);
    }

    if (contentResponse) {
      currentVideoInfo = contentResponse;
      videoTitleElement.textContent = contentResponse.videoTitle || "Loading...";
      channelNameElement.textContent = contentResponse.channelName || "";
      videoDurationOverlay.textContent = contentResponse.duration || "";
      
      // Update video status
      if (videoStatusText) {
        videoStatusText.textContent = "Video detected";
      }
      
      // Update views if available
      if (contentResponse.views && videoViewsElement) {
        videoViewsElement.textContent = formatViews(contentResponse.views);
      }
      // Show/hide separator based on views
      const metaSep = document.getElementById('meta-separator');
      if (metaSep) {
        metaSep.classList.toggle('hidden', !contentResponse.views);
      }

      if (contentResponse.thumbnail) {
        thumbnailImg.onload = () => {
          thumbnailImg.style.display = "block";
        };
        thumbnailImg.onerror = () => {
          // Hide thumbnail if it fails to load
          thumbnailImg.style.display = "none";
        };
        thumbnailImg.src = contentResponse.thumbnail;
        thumbnailImg.alt = contentResponse.videoTitle || "Video thumbnail";
      }
    } else {
      // Initialize with basic info from URL if content script not available
      currentVideoInfo = {
        url: tab.url,
        videoId: videoId,
        videoTitle: "YouTube Video",
        channelName: ""
      };
      videoTitleElement.textContent = "Loading video info...";
      // Show thumbnail from video ID
      if (videoId) {
        thumbnailImg.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        thumbnailImg.style.display = "block";
      }
    }

    // Check if we have cached info from background script (prefetched)
    let infoData = null;
    if (videoId) {
      try {
        logInfo("Checking for cached video info...");
        const cachedInfo = await browser.runtime.sendMessage({
          type: "GET_CACHED_INFO",
          videoId: videoId
        });
        if (cachedInfo && cachedInfo.success) {
          logSuccess("Using cached video info!", { title: cachedInfo.title, qualities: cachedInfo.available_qualities?.length });
          infoData = cachedInfo;
        } else {
          logInfo("No cached info available");
        }
      } catch (e) {
        logWarn("Cache check error:", e.message);
      }
    }

    // If no cached info, fetch from server
    if (!infoData) {
      const cleanUrl = cleanYouTubeUrl(tab.url);
      try {
        logInfo("Fetching video info from server...", { url: cleanUrl });
        status.textContent = "Loading video qualities...";
        status.style.color = "#888";
        // Use AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

        const infoResponse = await fetch(`${SERVER_URL}/info?url=${encodeURIComponent(cleanUrl)}`, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        infoData = await infoResponse.json();
        logSuccess("Server response received", { success: infoData.success, title: infoData.title, qualities: infoData.available_qualities?.length });
      } catch (serverError) {
        logError("Server error:", { name: serverError.name, message: serverError.message });
        qualitySelect.innerHTML = '<option value="">Server unavailable</option>';
        qualitySelect.disabled = true;
        downloadBtn.disabled = true;
        if (addToQueueBtn) addToQueueBtn.disabled = true;
        if (serverError.name === 'AbortError') {
          status.textContent = "Request timed out. Is the server running?";
        } else {
          status.textContent = "Server not running. Start the backend first.";
        }
        status.style.color = "#ff9800";
        return;
      }
    }

    // Process the info data (from cache or fresh fetch)
    if (infoData && infoData.success && infoData.available_qualities) {
      availableQualities = infoData.available_qualities;
      
      // Update video info from server (more accurate)
      if (infoData.title) {
        videoTitleElement.textContent = infoData.title;
        currentVideoInfo.videoTitle = infoData.title;
      }
      if (infoData.channel) {
        channelNameElement.textContent = infoData.channel;
        currentVideoInfo.channelName = infoData.channel;
      }
      if (infoData.duration) {
        videoDurationOverlay.textContent = formatDuration(infoData.duration);
      }
      // Update views if available  
      if (infoData.view_count && videoViewsElement) {
        videoViewsElement.textContent = formatViews(infoData.view_count);
        const metaSep = document.getElementById('meta-separator');
        if (metaSep) metaSep.classList.remove('hidden');
      }
      if (infoData.thumbnail) {
        thumbnailImg.onload = () => {
          thumbnailImg.style.display = "block";
        };
        thumbnailImg.onerror = () => {
          // Try fallback thumbnail
          if (currentVideoInfo && currentVideoInfo.videoId) {
            thumbnailImg.src = `https://img.youtube.com/vi/${currentVideoInfo.videoId}/hqdefault.jpg`;
          }
        };
        thumbnailImg.src = infoData.thumbnail;
      }
      
      // Populate with real qualities from the server
      populateQualities(availableQualities, infoData.duration || 0);
    } else {
      // Server returned no qualities — show error state
      logWarn("Server returned no available qualities");
      qualitySelect.innerHTML = '<option value="">No qualities available</option>';
      qualitySelect.disabled = true;
      downloadBtn.disabled = true;
      if (addToQueueBtn) addToQueueBtn.disabled = true;
      status.textContent = "Could not load video qualities.";
      status.style.color = "#ff9800";
      setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 4000);
    }

  } catch (error) {
    console.error("Error getting video info:", error);
    videoTitleElement.textContent = "Error loading video info";
    qualitySelect.innerHTML = '<option value="">Failed to load</option>';
    qualitySelect.disabled = true;
    downloadBtn.disabled = true;
    if (addToQueueBtn) addToQueueBtn.disabled = true;
  }
}

// Estimate filesize from resolution and duration when server doesn't provide one
// Uses rough average bitrates (video + audio) in bits per second
function estimateFileSize(height, durationSec) {
  if (!durationSec || durationSec <= 0) return null;
  const bitrates = {
    2160: 20000000,
    1440: 10000000,
    1080: 5000000,
    720:  2500000,
    480:  1200000,
    360:  700000,
    240:  400000,
    144:  200000,
  };
  // Find closest matching bitrate
  const keys = Object.keys(bitrates).map(Number).sort((a, b) => b - a);
  let bps = bitrates[360]; // default
  for (const k of keys) {
    if (height >= k) { bps = bitrates[k]; break; }
  }
  return Math.round(bps / 8 * durationSec);
}

// Populate quality selector with real qualities from the server
function populateQualities(qualities, duration) {
  logInfo("Populating real qualities from server", { count: qualities.length });

  qualitySelect.innerHTML = "";

  for (const quality of qualities) {
    const option = document.createElement("option");
    option.value = JSON.stringify({
      height: quality.height,
      codec: quality.codec,
      vcodec: quality.vcodec
    });

    // Show quality label with file size (real or estimated)
    let label = quality.label;
    let filesize = quality.filesize;
    if (!filesize && duration) {
      filesize = estimateFileSize(quality.height, duration);
    }
    if (filesize) {
      const sizeStr = formatFileSize(filesize);
      if (quality.filesize) {
        label += `  (${sizeStr})`;
      } else {
        label += `  (~${sizeStr})`;
      }
    }
    option.textContent = label;

    // Default to 720p if available, otherwise first option
    if (quality.height === 720) {
      option.selected = true;
    }

    qualitySelect.appendChild(option);
  }

  // Add audio-only option
  const audioOption = document.createElement("option");
  audioOption.value = JSON.stringify({ height: 0, codec: "mp3", isAudio: true });
  let audioLabel = "Audio Only (MP3)";
  if (duration) {
    // ~128kbps mp3
    const audioSize = Math.round(128000 / 8 * duration);
    audioLabel += `  (~${formatFileSize(audioSize)})`;
  }
  audioOption.textContent = audioLabel;
  qualitySelect.appendChild(audioOption);

  // Enable UI
  qualitySelect.disabled = false;
  downloadBtn.disabled = false;
  if (addToQueueBtn) addToQueueBtn.disabled = false;

  // Clear any loading status
  status.textContent = "";
  status.style.color = "";

  logSuccess(`Loaded ${qualities.length} real qualities from server`);
}

// Load playlist information
async function loadPlaylistInfo(url, playlistId) {
  isPlaylistMode = true;
  playlistContainer.style.display = "block";
  videoContainer.style.display = "none";
  downloadBtn.textContent = "Download Playlist";
  
  playlistTitle.textContent = "Loading playlist...";
  playlistCount.textContent = "";
  
  // Set default qualities for playlist (no per-video fetch)
  qualitySelect.innerHTML = "";
  const defaultQualities = [
    { height: 1080, label: "1080p" },
    { height: 720, label: "720p" },
    { height: 480, label: "480p" },
    { height: 360, label: "360p" }
  ];
  
  for (const q of defaultQualities) {
    const option = document.createElement("option");
    option.value = JSON.stringify({ height: q.height, codec: "" });
    option.textContent = q.label;
    if (q.height === 720) option.selected = true;
    qualitySelect.appendChild(option);
  }
  
  // Add audio-only option
  const audioOption = document.createElement("option");
  audioOption.value = JSON.stringify({ height: 0, codec: "mp3", isAudio: true });
  audioOption.textContent = "Audio Only (MP3)";
  qualitySelect.appendChild(audioOption);
  
  qualitySelect.disabled = false;
  downloadBtn.disabled = false;
  
  // Fetch playlist info from server
  try {
    const response = await fetch(`${SERVER_URL}/playlist-info?url=${encodeURIComponent(url)}`);
    const data = await response.json();
    
    if (data.success) {
      currentPlaylistInfo = {
        ...data,
        url: url,
        playlistId: playlistId
      };
      playlistTitle.textContent = data.title || "Playlist";
      playlistCount.innerHTML = `<span class="count-number">${data.video_count}</span> videos`;
    } else {
      playlistTitle.textContent = "Playlist";
      playlistCount.textContent = "Ready to download";
      currentPlaylistInfo = { url: url, playlistId: playlistId };
    }
  } catch (e) {
    console.error("Error fetching playlist info:", e);
    playlistTitle.textContent = "Playlist";
    playlistCount.textContent = "Ready to download";
    currentPlaylistInfo = { url: url, playlistId: playlistId };
  }
}

downloadBtn.addEventListener("click", async () => {
  const selectedValue = qualitySelect.value;
  let qualityData;
  
  try {
    qualityData = JSON.parse(selectedValue);
  } catch {
    // Fallback format (old style)
    qualityData = { height: parseInt(selectedValue) || 0, codec: "", isAudio: selectedValue === "audio" };
  }
  
  // Immediately show downloading status
  downloadBtn.disabled = true;
  
  if (isPlaylistMode) {
    // Playlist download
    if (!currentPlaylistInfo) {
      logWarn("No playlist info available");
      return;
    }
    
    logInfo("Starting playlist download", { title: currentPlaylistInfo.title, quality: qualityData });
    const subtitleInfo = subtitleCheckbox.checked ? ` (with ${subtitleLang.options[subtitleLang.selectedIndex].text} subtitles)` : "";
    status.textContent = `Starting playlist download${subtitleInfo}...`;
    downloadBtn.textContent = "Downloading...";
    
    try {
      const response = await browser.runtime.sendMessage({
        type: "DOWNLOAD_PLAYLIST",
        url: currentPlaylistInfo.url || `https://www.youtube.com/playlist?list=${currentPlaylistInfo.playlistId}`,
        quality: qualityData,
        playlistTitle: currentPlaylistInfo.title || "playlist",
        subtitles: subtitleCheckbox.checked ? subtitleLang.value : null
      });
      
      if (response.success) {
        logSuccess("Playlist download started", response);
        status.textContent = "Playlist download started! Check your downloads.";
        status.style.color = "#4CAF50";
      } else {
        throw new Error(response.error || "Download failed");
      }
    } catch (error) {
      logError("Playlist download error:", { message: error.message });
      status.textContent = "Error: " + error.message;
      status.style.color = "#f44336";
    } finally {
      setTimeout(() => {
        downloadBtn.disabled = false;
        downloadBtn.textContent = "Download Playlist";
        status.textContent = "";
        status.style.color = "";
      }, 3000);
    }
  } else {
    // Single video download
    if (!currentVideoInfo) {
      logWarn("No video info available");
      return;
    }
    
    logInfo("Starting video download", { title: currentVideoInfo.videoTitle, quality: qualityData, subtitles: subtitleCheckbox.checked ? subtitleLang.value : null });
    const subtitleInfo = subtitleCheckbox.checked ? ` (with ${subtitleLang.options[subtitleLang.selectedIndex].text} subtitles)` : "";
    status.textContent = `Downloading${subtitleInfo}...`;
    downloadBtn.textContent = "Downloading...";

    try {
      const response = await browser.runtime.sendMessage({
        type: "DOWNLOAD_VIDEO",
        url: currentVideoInfo.url,
        quality: qualityData,
        videoTitle: currentVideoInfo.videoTitle,
        channelName: currentVideoInfo.channelName,
        subtitles: subtitleCheckbox.checked ? subtitleLang.value : null
      });
      
      if (response.success) {
        logSuccess("Video download started", response);
        status.textContent = "Download started! Check your downloads.";
        status.style.color = "#4CAF50";
      } else {
        throw new Error(response.error || "Download failed");
      }
    } catch (error) {
      logError("Video download error:", { message: error.message });
      status.textContent = "Error: " + error.message;
      status.style.color = "#f44336";
    } finally {
      setTimeout(() => {
        downloadBtn.disabled = false;
        downloadBtn.textContent = "Download";
        status.textContent = "";
        status.style.color = "";
      }, 3000);
    }
  }
});

// ==================== QUEUE SYSTEM ====================

// Generate unique ID for queue items
function generateQueueId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Add video to download queue (via background script)
async function addToQueue() {
  logQueue("Add to queue button clicked");
  
  if (!queueEnabled) {
    logError("Queue UI elements not found");
    return;
  }
  
  if (!currentVideoInfo || isPlaylistMode) {
    logWarn("Cannot add to queue:", { hasVideoInfo: !!currentVideoInfo, isPlaylistMode });
    status.textContent = "No video to add to queue";
    status.style.color = "#f44336";
    setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 2000);
    return;
  }
  
  const selectedValue = qualitySelect.value;
  if (!selectedValue) {
    logWarn("No quality selected");
    status.textContent = "Please select a quality first";
    status.style.color = "#f44336";
    setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 2000);
    return;
  }
  
  let qualityData;
  try {
    qualityData = JSON.parse(selectedValue);
  } catch {
    qualityData = { height: 720, codec: "" };
  }
  
  // Get quality label for display
  const selectedOption = qualitySelect.options[qualitySelect.selectedIndex];
  const qualityLabel = selectedOption ? selectedOption.textContent : `${qualityData.height}p`;
  
  const queueItem = {
    id: generateQueueId(),
    url: currentVideoInfo.url,
    videoId: currentVideoInfo.videoId || extractVideoId(currentVideoInfo.url),
    title: currentVideoInfo.videoTitle || "Unknown Video",
    channel: currentVideoInfo.channelName || "",
    thumbnail: thumbnailImg.src || "",
    quality: qualityData,
    qualityLabel: qualityLabel,
    subtitles: subtitleCheckbox.checked ? subtitleLang.value : null,
    status: "pending",
    error: null,
    addedAt: Date.now()
  };
  
  logQueue("Queue item created:", queueItem);
  
  try {
    // Send to background script
    logQueue("Sending ADD_TO_QUEUE message to background...");
    const result = await browser.runtime.sendMessage({
      type: "ADD_TO_QUEUE",
      item: queueItem
    });
    
    logQueue("ADD_TO_QUEUE response:", result);
    
    if (result && result.success) {
      logSuccess(`Added to queue: "${queueItem.title}"`);
      status.textContent = "Added to queue!";
      status.style.color = "#4CAF50";
      // Refresh queue display
      loadQueueFromBackground();
    } else {
      logWarn("Add to queue failed:", result?.error);
      status.textContent = result?.error || "Failed to add to queue";
      status.style.color = "#ff9800";
    }
  } catch (error) {
    logError("Error adding to queue:", { message: error.message, stack: error.stack });
    status.textContent = "Error adding to queue";
    status.style.color = "#f44336";
  }
  
  setTimeout(() => {
    status.textContent = "";
    status.style.color = "";
  }, 2000);
}

// Render the queue UI
function renderQueue() {
  if (!queueEnabled) {
    logWarn("Queue not enabled, skipping render");
    return;
  }
  
  const stats = {
    total: downloadQueue.length,
    pending: downloadQueue.filter(i => i.status === "pending").length,
    downloading: downloadQueue.filter(i => i.status === "downloading").length,
    completed: downloadQueue.filter(i => i.status === "completed").length,
    failed: downloadQueue.filter(i => i.status === "failed").length
  };
  logUI("Rendering queue", stats);
  
  // Update queue count
  const queueCountEl = document.getElementById("queue-count");
  if (queueCountEl) {
    queueCountEl.textContent = `${downloadQueue.length} item${downloadQueue.length !== 1 ? 's' : ''}`;
  }
  
  // Show/hide empty state
  if (queueEmpty) {
    queueEmpty.classList.toggle("hidden", downloadQueue.length > 0);
  }
  
  // Render queue items
  queueList.innerHTML = "";
  
  for (let i = 0; i < downloadQueue.length; i++) {
    const item = downloadQueue[i];
    const itemEl = document.createElement("div");
    itemEl.className = `queue-item ${item.status}`;
    itemEl.dataset.id = item.id;
    
    const thumbnailUrl = item.thumbnail || 
      (item.videoId ? `https://img.youtube.com/vi/${item.videoId}/default.jpg` : "");
    
    let statusText = "";
    let statusClass = "";
    switch (item.status) {
      case "pending":
        statusText = "Waiting";
        statusClass = "waiting";
        break;
      case "downloading":
        statusText = "Downloading";
        statusClass = "downloading";
        break;
      case "completed":
        statusText = "Completed";
        statusClass = "completed";
        break;
      case "failed":
        statusText = "Failed";
        statusClass = "failed";
        break;
      default:
        statusText = "Waiting";
        statusClass = "waiting";
    }
    
    // Build progress section — always show for downloading items
    let progressHTML = "";
    if (item.status === "downloading") {
      const progress = Math.round(item.progress || 0);
      const downloaded = item.downloadedSize || "0 B";
      const total = item.totalSize || "---";
      const sizeText = item.totalSize ? `${downloaded} / ${total}` : "Starting...";
      progressHTML = `
        <div class="queue-item-progress">
          <div class="queue-item-progress-bar">
            <div class="queue-item-progress-fill${progress === 0 ? ' indeterminate' : ''}" style="width: ${progress || 0}%"></div>
          </div>
          <div class="queue-item-progress-text">
            <span>${sizeText}</span>
            <span>${progress}%</span>
          </div>
        </div>
      `;
    }
    
    // Build details section
    const qualityLabel = item.qualityLabel || "1080p";
    const fileSize = item.totalSize || item.fileSize || "";
    const position = i + 1;
    
    let detailsHTML = `
      <div class="queue-item-details">
        <span class="queue-item-meta">${qualityLabel}${fileSize ? ' • ' + fileSize : ''}</span>
    `;
    
    // Add badges
    if (item.subtitles) {
      detailsHTML += `<span class="queue-item-badge subtitle-badge">CC ${item.subtitles.toUpperCase()}</span>`;
    }
    
    // Add position for waiting items
    if (item.status === "pending" && position > 1) {
      detailsHTML += `<span class="queue-item-position">Position #${position} in queue</span>`;
    }
    
    // Add HDR badge if applicable
    if (item.hdr || qualityLabel.includes("HDR")) {
      detailsHTML += `<span class="queue-item-badge">HDR</span>`;
    }
    
    detailsHTML += `</div>`;
    
    itemEl.innerHTML = `
      ${thumbnailUrl ? `<img class="queue-item-thumbnail" src="${thumbnailUrl}" alt="">` : ""}
      <div class="queue-item-info">
        <div class="queue-item-title" title="${item.title}">${item.title}</div>
        <div class="queue-item-status-text ${statusClass}">${statusText}</div>
        ${progressHTML}
        ${detailsHTML}
      </div>
      <div class="queue-item-actions">
        <button class="queue-item-remove" title="Remove" data-id="${item.id}">✕</button>
      </div>
    `;
    
    queueList.appendChild(itemEl);
  }
  
  // Add click handlers for remove buttons
  queueList.querySelectorAll(".queue-item-remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromQueue(btn.dataset.id);
    });
  });
  
  // Apply current filter after rendering
  applyQueueFilter();
  
  // Update header badge
  updateQueueBadge();
}

// Apply queue tab filter to show/hide items
function applyQueueFilter() {
  if (!queueList) return;
  const items = queueList.querySelectorAll(".queue-item");
  let visibleCount = 0;
  
  items.forEach(item => {
    const id = item.dataset.id;
    const queueItem = downloadQueue.find(q => q.id === id);
    if (!queueItem) return;
    
    let show = true;
    const filter = typeof currentQueueFilter !== "undefined" ? currentQueueFilter : "all";
    
    if (filter === "active") {
      show = queueItem.status === "pending" || queueItem.status === "downloading";
    } else if (filter === "finished") {
      show = queueItem.status === "completed" || queueItem.status === "failed";
    }
    
    item.style.display = show ? "" : "none";
    if (show) visibleCount++;
  });
  
  // Show empty state if filter has no results but queue has items
  if (queueEmpty) {
    const emptyText = queueEmpty.querySelector(".empty-text");
    if (downloadQueue.length === 0) {
      queueEmpty.classList.remove("hidden");
      if (emptyText) emptyText.textContent = "Queue is empty";
    } else if (visibleCount === 0) {
      queueEmpty.classList.remove("hidden");
      const filter = typeof currentQueueFilter !== "undefined" ? currentQueueFilter : "all";
      if (emptyText) {
        emptyText.textContent = 
          filter === "active" ? "No active downloads" : "No finished downloads";
      }
    } else {
      queueEmpty.classList.add("hidden");
    }
  }
}

// Update the queue badge count in the header
function updateQueueBadge() {
  const headerBadge = document.getElementById("queue-header-badge");
  const pendingCount = downloadQueue.filter(i => i.status === "pending" || i.status === "downloading").length;
  
  if (headerBadge) {
    if (pendingCount > 0) {
      headerBadge.textContent = pendingCount;
      headerBadge.classList.remove("hidden");
    } else {
      headerBadge.classList.add("hidden");
    }
  }
}

// Sync pause button visual state with background isPaused flag
function syncPauseButtonState(isPaused) {
  const pauseAllBtn = document.getElementById("pause-all-btn");
  if (!pauseAllBtn) return;
  
  if (isPaused) {
    pauseAllBtn.classList.add("paused");
    const icon = pauseAllBtn.querySelector(".btn-icon");
    const text = pauseAllBtn.querySelector(".btn-text");
    if (icon) icon.textContent = "▶";
    if (text) text.textContent = "Resume All";
  } else {
    pauseAllBtn.classList.remove("paused");
    const icon = pauseAllBtn.querySelector(".btn-icon");
    const text = pauseAllBtn.querySelector(".btn-text");
    if (icon) icon.textContent = "⏸";
    if (text) text.textContent = "Pause All";
  }
}

// Remove item from queue (via background script)
async function removeFromQueue(id) {
  logQueue(`Removing item from queue: ${id}`);
  try {
    const result = await browser.runtime.sendMessage({
      type: "REMOVE_FROM_QUEUE",
      id: id
    });
    logQueue("Remove result:", result);
    if (result && result.success) {
      logSuccess(`Removed from queue: ${id}`);
      loadQueueFromBackground();
    } else {
      logWarn("Remove failed:", result?.error);
    }
  } catch (error) {
    logError("Error removing from queue:", { message: error.message });
  }
}

// Clear completed/failed items from queue (via background script)
async function clearCompletedFromQueue() {
  logQueue("Clearing completed/failed items...");
  try {
    const result = await browser.runtime.sendMessage({
      type: "CLEAR_COMPLETED"
    });
    logQueue("Clear result:", result);
    if (result && result.success) {
      logSuccess(`Queue cleared, ${result.queueLength} items remaining`);
      loadQueueFromBackground();
    }
  } catch (error) {
    logError("Error clearing queue:", { message: error.message });
  }
}

// Load queue from background script
async function loadQueueFromBackground() {
  try {
    logQueue("Loading queue from background...");
    const state = await browser.runtime.sendMessage({ type: "GET_QUEUE" });
    logQueue("Got queue state from background:", { 
      queueLength: state?.queue?.length || 0, 
      isProcessing: state?.isProcessing,
      items: state?.queue?.map(i => ({ id: i.id, title: i.title?.substring(0, 30), status: i.status }))
    });
    if (state && state.queue) {
      downloadQueue = state.queue;
      isProcessingQueue = state.isProcessing;
      syncPauseButtonState(state.isPaused);
    } else {
      downloadQueue = [];
      isProcessingQueue = false;
    }
    renderQueue();
  } catch (error) {
    logError("Error loading queue from background:", { message: error.message });
    downloadQueue = [];
    renderQueue();
  }
}

// Listen for queue updates from background script
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "QUEUE_UPDATED") {
    logQueue("📩 Received QUEUE_UPDATED from background", {
      queueLength: message.queue?.length || 0,
      isProcessing: message.isProcessing,
      items: message.queue?.map(i => ({ title: i.title?.substring(0, 25), status: i.status }))
    });
    downloadQueue = message.queue || [];
    isProcessingQueue = message.isProcessing || false;
    syncPauseButtonState(message.isPaused);
    renderQueue();
  }
  
  if (message.type === "HISTORY_UPDATED") {
    logInfo("📩 Received HISTORY_UPDATED from background", {
      historyLength: message.history?.length || 0
    });
    downloadHistory = message.history || [];
    renderHistory();
  }
});

// Load queue from browser storage
async function loadQueueFromStorage() {
  try {
    logUI("Loading queue from storage...");
    
    // Load actual queue from background script
    await loadQueueFromBackground();
  } catch (e) {
    logError("Error loading queue:", { message: e.message });
    renderQueue();
  }
}

// Toggle queue collapse
function showQueue() {
  if (queueOverlay) {
    queueOverlay.classList.add("active");
  }
}

function hideQueue() {
  if (queueOverlay) {
    queueOverlay.classList.remove("active");
  }
}

// ==================== HISTORY SYSTEM ====================

// Load history from background script
async function loadHistoryFromBackground() {
  try {
    logInfo("Loading history from background...");
    const result = await browser.runtime.sendMessage({ type: "GET_HISTORY" });
    if (result && result.history) {
      downloadHistory = result.history;
      logInfo(`History loaded: ${downloadHistory.length} entries`);
    } else {
      downloadHistory = [];
    }
    renderHistory();
  } catch (error) {
    logError("Error loading history:", { message: error.message });
    downloadHistory = [];
    renderHistory();
  }
}

// Render the history UI
function renderHistory() {
  if (!historyEnabled) {
    return;
  }
  
  const completedCount = downloadHistory.filter(h => h.status === "completed").length;
  const failedCount = downloadHistory.filter(h => h.status === "failed").length;
  
  logUI("Rendering history", { total: downloadHistory.length, completed: completedCount, failed: failedCount });
  
  // Update badge count
  if (historyBadge) {
    historyBadge.textContent = downloadHistory.length;
    historyBadge.classList.toggle("empty", downloadHistory.length === 0);
  }
  
  // Show/hide empty state
  if (historyEmpty) {
    historyEmpty.classList.toggle("hidden", downloadHistory.length > 0);
  }
  
  // Show/hide retry all button (only if there are failed items)
  if (retryAllBtn) {
    retryAllBtn.classList.toggle("hidden", failedCount === 0);
  }
  
  // Update stats
  const historyPanelFooter = document.getElementById("history-panel-footer");
  if (historyStats) {
    if (downloadHistory.length > 0) {
      const parts = [];
      if (completedCount > 0) parts.push(`${completedCount} completed`);
      if (failedCount > 0) parts.push(`${failedCount} failed`);
      historyStats.textContent = parts.join(" • ");
      if (historyPanelFooter) historyPanelFooter.classList.add("visible");
    } else {
      if (historyPanelFooter) historyPanelFooter.classList.remove("visible");
    }
  }
  
  // Render history items
  historyList.innerHTML = "";
  
  for (const item of downloadHistory) {
    const itemEl = document.createElement("div");
    itemEl.className = `history-item ${item.status}`;
    itemEl.dataset.id = item.id;
    
    const thumbnailUrl = item.thumbnail || 
      (item.videoId ? `https://img.youtube.com/vi/${item.videoId}/default.jpg` : "");
    
    let statusIcon = "";
    let statusText = "";
    switch (item.status) {
      case "completed":
        statusIcon = "✓";
        statusText = "Completed";
        break;
      case "failed":
        statusIcon = "✕";
        statusText = item.error ? `Failed: ${item.error.substring(0, 20)}...` : "Failed";
        break;
      default:
        statusIcon = "?";
        statusText = "Unknown";
    }
    
    // Format date
    const completedDate = item.completedAt ? new Date(item.completedAt) : null;
    const dateStr = completedDate ? formatRelativeTime(completedDate) : "";
    
    // Truncate title if too long
    const truncatedTitle = item.title && item.title.length > 35 
      ? item.title.substring(0, 35) + "..." 
      : (item.title || "Unknown");
    
    // Build action buttons
    let actionButtons = `<button class="history-item-remove" title="Remove" data-id="${item.id}">×</button>`;
    if (item.status === "failed") {
      actionButtons = `<button class="history-item-retry" title="Retry download" data-id="${item.id}">🔄</button>` + actionButtons;
    }
    
    itemEl.innerHTML = `
      ${thumbnailUrl ? `<img class="history-item-thumbnail" src="${thumbnailUrl}" alt="">` : ""}
      <div class="history-item-info">
        <div class="history-item-title" title="${item.title || ''}">${truncatedTitle}</div>
        <div class="history-item-details">
          <span class="history-item-quality">${item.qualityLabel || ""}</span>
          ${dateStr ? `<span class="history-item-date">${dateStr}</span>` : ""}
        </div>
      </div>
      <span class="history-item-status ${item.status}">${statusIcon} ${statusText}</span>
      <div class="history-item-actions">
        ${actionButtons}
      </div>
    `;
    
    historyList.appendChild(itemEl);
  }
  
  // Add click handlers for retry buttons
  historyList.querySelectorAll(".history-item-retry").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      retryDownload(btn.dataset.id);
    });
  });
  
  // Add click handlers for remove buttons
  historyList.querySelectorAll(".history-item-remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromHistory(btn.dataset.id);
    });
  });
}

// Format relative time (e.g., "2 hours ago")
function formatRelativeTime(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  
  if (diffDay > 0) return diffDay === 1 ? "1 day ago" : `${diffDay} days ago`;
  if (diffHour > 0) return diffHour === 1 ? "1 hour ago" : `${diffHour} hours ago`;
  if (diffMin > 0) return diffMin === 1 ? "1 min ago" : `${diffMin} mins ago`;
  return "Just now";
}

// Retry a failed download
async function retryDownload(id) {
  logInfo(`Retrying download: ${id}`);
  try {
    const result = await browser.runtime.sendMessage({
      type: "RETRY_DOWNLOAD",
      id: id
    });
    
    if (result && result.success) {
      logSuccess(`Download queued for retry: ${id}`);
      status.textContent = "Added to queue for retry!";
      status.style.color = "#4CAF50";
      // Refresh both queue and history
      loadQueueFromBackground();
      loadHistoryFromBackground();
    } else {
      logWarn("Retry failed:", result?.error);
      status.textContent = result?.error || "Retry failed";
      status.style.color = "#ff9800";
    }
  } catch (error) {
    logError("Error retrying download:", { message: error.message });
    status.textContent = "Error retrying download";
    status.style.color = "#f44336";
  }
  
  setTimeout(() => {
    status.textContent = "";
    status.style.color = "";
  }, 3000);
}

// Retry all failed downloads
async function retryAllFailed() {
  logInfo("Retrying all failed downloads...");
  try {
    const result = await browser.runtime.sendMessage({ type: "RETRY_ALL_FAILED" });
    
    if (result && result.success) {
      if (result.retried > 0) {
        logSuccess(`Queued ${result.retried} downloads for retry`);
        status.textContent = `Queued ${result.retried} downloads for retry!`;
        status.style.color = "#4CAF50";
      } else {
        status.textContent = "No failed downloads to retry";
        status.style.color = "#ff9800";
      }
      loadQueueFromBackground();
      loadHistoryFromBackground();
    } else {
      status.textContent = result?.error || "Retry all failed";
      status.style.color = "#f44336";
    }
  } catch (error) {
    logError("Error retrying all failed:", { message: error.message });
    status.textContent = "Error retrying downloads";
    status.style.color = "#f44336";
  }
  
  setTimeout(() => {
    status.textContent = "";
    status.style.color = "";
  }, 3000);
}

// Remove item from history
async function removeFromHistory(id) {
  logInfo(`Removing from history: ${id}`);
  try {
    const result = await browser.runtime.sendMessage({
      type: "REMOVE_FROM_HISTORY",
      id: id
    });
    
    if (result && result.success) {
      logSuccess(`Removed from history: ${id}`);
      loadHistoryFromBackground();
    } else {
      logWarn("Remove from history failed:", result?.error);
    }
  } catch (error) {
    logError("Error removing from history:", { message: error.message });
  }
}

// Clear all history
async function clearAllHistory() {
  logInfo("Clearing all history...");
  try {
    const result = await browser.runtime.sendMessage({ type: "CLEAR_HISTORY" });
    
    if (result && result.success) {
      logSuccess(`Cleared ${result.cleared} history entries`);
      loadHistoryFromBackground();
    }
  } catch (error) {
    logError("Error clearing history:", { message: error.message });
  }
}

// Toggle history collapse
function showHistory() {
  if (historyOverlay) {
    historyOverlay.classList.add("active");
  }
}

function hideHistory() {
  if (historyOverlay) {
    historyOverlay.classList.remove("active");
  }
}

function showSettings() {
  if (settingsOverlay) {
    settingsOverlay.classList.add("active");
  }
}

function hideSettings() {
  if (settingsOverlay) {
    settingsOverlay.classList.remove("active");
  }
}

// Load history collapsed state from storage
async function loadHistorySettings() {
  try {
    await loadHistoryFromBackground();
  } catch (e) {
    logError("Error loading history settings:", { message: e.message });
    renderHistory();
  }
}

// Event listeners for queue
if (queueEnabled) {
  logUI("Setting up queue event listeners...");
  
  addToQueueBtn.addEventListener("click", addToQueue);
  
  // Queue control buttons
  const pauseAllBtn = document.getElementById("pause-all-btn");
  const clearCompletedBtn = document.getElementById("clear-completed-btn");
  
  if (pauseAllBtn) {
    pauseAllBtn.addEventListener("click", async () => {
      const isPaused = pauseAllBtn.classList.contains("paused");
      logUI(`${isPaused ? "Resume" : "Pause"} all clicked`);
      
      try {
        const result = await browser.runtime.sendMessage({
          type: isPaused ? "RESUME_QUEUE" : "PAUSE_QUEUE"
        });
        
        if (result && result.success) {
          if (isPaused) {
            pauseAllBtn.classList.remove("paused");
            pauseAllBtn.querySelector(".btn-icon").textContent = "⏸";
            pauseAllBtn.querySelector(".btn-text").textContent = "Pause All";
          } else {
            pauseAllBtn.classList.add("paused");
            pauseAllBtn.querySelector(".btn-icon").textContent = "▶";
            pauseAllBtn.querySelector(".btn-text").textContent = "Resume All";
          }
        }
      } catch (e) {
        logError("Error toggling pause:", { message: e.message });
      }
    });
  }
  
  if (clearCompletedBtn) {
    clearCompletedBtn.addEventListener("click", clearCompletedFromQueue);
  }
  
  // Queue tabs
  const queueTabs = document.querySelectorAll(".queue-tab");
  queueTabs.forEach(tab => {
    tab.addEventListener("click", (e) => {
      // Remove active from all tabs
      queueTabs.forEach(t => t.classList.remove("active"));
      // Add active to clicked tab
      tab.classList.add("active");
      
      currentQueueFilter = tab.dataset.filter;
      logUI(`Queue filter changed to: ${currentQueueFilter}`);
      applyQueueFilter();
    });
  });
  
  if (queueBtn) {
    queueBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showQueue();
    });
  }
  
  if (closeQueueBtn) {
    closeQueueBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideQueue();
    });
  }
  
  // Click overlay backdrop to close
  if (queueOverlay) {
    queueOverlay.addEventListener("click", (e) => {
      if (e.target === queueOverlay) {
        hideQueue();
      }
    });
  }
  
  logSuccess("Queue event listeners ready");
  
  // Load queue on popup open
  loadQueueFromStorage();
} else {
  logWarn("Queue UI elements not found - queue disabled");
}

// Event listeners for history
if (historyEnabled) {
  logUI("Setting up history event listeners...");
  
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("click", clearAllHistory);
  }
  
  if (retryAllBtn) {
    retryAllBtn.addEventListener("click", retryAllFailed);
  }
  
  if (historyBtn) {
    historyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showHistory();
    });
  }
  
  if (closeHistoryBtn) {
    closeHistoryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideHistory();
    });
  }
  
  // Click overlay backdrop to close
  if (historyOverlay) {
    historyOverlay.addEventListener("click", (e) => {
      if (e.target === historyOverlay) {
        hideHistory();
      }
    });
  }
  
  logSuccess("History event listeners ready");
  
  // Load history on popup open
  loadHistorySettings();
} else {
  logWarn("History UI elements not found - history disabled");
}

// ==================== SETTINGS OVERLAY ====================
if (settingsBtn && settingsOverlay) {
  // Settings overlay toggle
  if (settingsBtn) {
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showSettings();
    });
  }
  
  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideSettings();
    });
  }
  
  // Click overlay backdrop to close
  if (settingsOverlay) {
    settingsOverlay.addEventListener("click", (e) => {
      if (e.target === settingsOverlay) {
        hideSettings();
      }
    });
  }
  
  logSuccess("Settings event listeners ready");
} else {
  logWarn("Settings UI elements not found - settings disabled");
}

// ==================== SERVER URL SETTINGS ====================

const saveServerUrlBtn = document.getElementById("save-server-url-btn");
if (saveServerUrlBtn) {
  saveServerUrlBtn.addEventListener("click", async () => {
    const input = document.getElementById("server-url-input");
    if (!input) return;
    const newUrl = input.value.trim().replace(/\/$/, ""); // strip trailing slash
    if (!newUrl) return;
    SERVER_URL = newUrl;
    await browser.runtime.sendMessage({ type: "SET_SERVER_URL", url: newUrl });
    saveServerUrlBtn.textContent = "Saved!";
    setTimeout(() => { saveServerUrlBtn.textContent = "Save"; }, 2000);
    updateServerStatus();
  });
}

// ==================== LOG CONTROLS ====================

// Update log count display
async function updateLogCount() {
  const count = await getLogCount();
  if (logCount) {
    logCount.textContent = count;
  }
}

// Set up log control event listeners
if (exportLogsBtn) {
  exportLogsBtn.addEventListener("click", async () => {
    logUI("Export button clicked");
    exportLogsBtn.disabled = true;
    const exportBtnText = exportLogsBtn.querySelector(".btn-text");
    if (exportBtnText) exportBtnText.textContent = "Saving...";
    
    try {
      const result = await browser.runtime.sendMessage({ type: "EXPORT_LOGS" });
      console.log("Export result:", result);
      
      exportLogsBtn.disabled = false;
      if (exportBtnText) exportBtnText.textContent = "Export";
      
      if (result && result.success) {
        const msg = result.entries > 0 
          ? `✓ Exported ${result.entries} log entries`
          : "No logs to export";
        status.textContent = msg;
        status.style.color = "#4CAF50";
        setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 4000);
      } else if (result) {
        status.textContent = "Error: " + (result.error || "Export failed");
        status.style.color = "#f44336";
        setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 4000);
      } else {
        status.textContent = "Error: No response from background";
        status.style.color = "#f44336";
        setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 4000);
      }
    } catch (e) {
      console.error("Export error:", e);
      exportLogsBtn.disabled = false;
      if (exportBtnText) exportBtnText.textContent = "Export";
      status.textContent = "Error: " + e.message;
      status.style.color = "#f44336";
      setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 4000);
    }
  });
}

if (clearLogsBtn) {
  clearLogsBtn.addEventListener("click", async () => {
    if (confirm("Clear all logs? This cannot be undone.")) {
      logUI("Clear logs button clicked");
      const result = await clearAllLogs();
      if (result.success) {
        updateLogCount();
        status.textContent = "Logs cleared!";
        status.style.color = "#4CAF50";
        setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 2000);
      }
    }
  });
}

// Update log count on popup open
updateLogCount();

// Initialize server status
async function updateServerStatus() {
  // Check server connectivity
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(`${SERVER_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    
    if (response.ok) {
      const data = await response.json();
      if (serverStatusText) serverStatusText.textContent = "Server ready";
      if (serverStatusDot) {
        serverStatusDot.style.background = "#00ff88";
        serverStatusDot.style.boxShadow = "0 0 6px rgba(0, 255, 136, 0.6)";
      }
      logSuccess("Server connected", data);
    } else {
      setServerOffline();
    }
  } catch (e) {
    setServerOffline();
    logWarn("Server not reachable:", { message: e.message });
  }
  
  // Fetch disk space
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(`${SERVER_URL}/disk-space`, { signal: controller.signal });
    clearTimeout(timeout);
    
    if (response.ok) {
      const data = await response.json();
      if (storageText) {
        storageText.textContent = `Free Space: ${data.free_human}`;
      }
    }
  } catch (e) {
    if (storageText) storageText.textContent = "Free Space: --";
  }
  
  // Set initial video status
  if (videoStatusText) {
    videoStatusText.textContent = "Detecting video...";
  }
}

function setServerOffline() {
  if (serverStatusText) serverStatusText.textContent = "Server offline";
  if (serverStatusDot) {
    serverStatusDot.style.background = "#ff4444";
    serverStatusDot.style.boxShadow = "0 0 6px rgba(255, 68, 68, 0.6)";
  }
}

// Initialize — load server URL from storage first, then boot the UI
(async () => {
  const result = await browser.storage.local.get("serverUrl");
  if (result.serverUrl) SERVER_URL = result.serverUrl;

  // Populate server URL input in settings
  const serverUrlInput = document.getElementById("server-url-input");
  if (serverUrlInput) serverUrlInput.value = SERVER_URL;

  // Periodically check server status (every 30 seconds)
  setInterval(updateServerStatus, 30000);

  updateServerStatus();
  logInfo("Loading video info...");
  loadVideoInfo();
})();