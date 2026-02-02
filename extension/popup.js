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
        await browser.runtime.sendMessage({
            type: "ADD_LOG",
            source: "popup",
            logType: type.toUpperCase(),
            message: message,
            data: data && data.length > 0 ? data : null
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

// Export logs to file
async function exportLogs() {
    try {
        const result = await browser.runtime.sendMessage({ type: "EXPORT_LOGS" });
        if (result.success) {
            logSuccess("Logs exported to: " + result.filename);
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
const thumbnailImg = document.getElementById("thumbnail-img");
const subtitleCheckbox = document.getElementById("subtitle-checkbox");
const subtitleLang = document.getElementById("subtitle-lang");

// Queue elements
const addToQueueBtn = document.getElementById("add-to-queue-btn");
const queueList = document.getElementById("queue-list");
const queueBadge = document.getElementById("queue-badge");
const clearQueueBtn = document.getElementById("clear-queue-btn");
const queueSection = document.getElementById("queue-section");
const toggleQueueBtn = document.getElementById("toggle-queue-btn");
const queueListContainer = document.getElementById("queue-list-container");
const queueEmpty = document.getElementById("queue-empty");
const queueFooter = document.getElementById("queue-footer");
const queueStats = document.getElementById("queue-stats");

// Download queue state
let downloadQueue = [];
let isProcessingQueue = false;
let queueCollapsed = false;

// Check if queue UI elements exist (only check essential elements)
const queueEnabled = !!(addToQueueBtn && queueList && queueSection);

logUI("Queue UI elements check:", {
  enabled: queueEnabled,
  addToQueueBtn: !!addToQueueBtn,
  queueList: !!queueList,
  queueSection: !!queueSection,
  queueBadge: !!queueBadge,
  clearQueueBtn: !!clearQueueBtn
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
});

const SERVER_URL = "http://localhost:5000";

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

    // Show video mode UI
    isPlaylistMode = false;
    playlistContainer.style.display = "none";
    videoContainer.style.display = "block";
    downloadBtn.textContent = "Download";

    // Show fallback qualities immediately so user can interact
    // Better qualities will load in background
    populateFallbackQualities();
    qualitySelect.disabled = false;
    downloadBtn.disabled = false;
    if (addToQueueBtn) addToQueueBtn.disabled = false;

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
      videoDurationElement.textContent = contentResponse.duration || "";

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
        status.textContent = "Loading better qualities...";
        status.style.color = "#888";
        // Use AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
        
        const infoResponse = await fetch(`${SERVER_URL}/info?url=${encodeURIComponent(cleanUrl)}`, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        infoData = await infoResponse.json();
        logSuccess("Server response received", { success: infoData.success, title: infoData.title, qualities: infoData.available_qualities?.length });
      } catch (serverError) {
        logError("Server error:", { name: serverError.name, message: serverError.message });
        if (serverError.name === 'AbortError') {
          status.textContent = "Couldn't load qualities. Using defaults.";
        } else {
          status.textContent = "Server not running. Using default qualities.";
        }
        status.style.color = "#ff9800";
        // Clear status after a moment - fallback qualities are already loaded
        setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 3000);
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
        videoDurationElement.textContent = formatDuration(infoData.duration);
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
      
      // Populate quality dropdown with actual available qualities
      qualitySelect.innerHTML = "";
      
      for (const quality of availableQualities) {
        const option = document.createElement("option");
        option.value = JSON.stringify({
          height: quality.height,
          codec: quality.codec,
          vcodec: quality.vcodec
        });
        
        // Show quality label with file size if available
        let label = quality.label;
        if (quality.filesize) {
          const sizeStr = formatFileSize(quality.filesize);
          label += ` (${sizeStr})`;
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
      audioOption.textContent = "Audio Only (MP3)";
      qualitySelect.appendChild(audioOption);
      
      // Enable the dropdown and download button
      qualitySelect.disabled = false;
      downloadBtn.disabled = false;
      if (addToQueueBtn) addToQueueBtn.disabled = false;
      status.textContent = "";
    } else {
      // Fallback to default qualities if server fetch fails
      console.warn("Could not fetch qualities from server, using defaults");
      populateFallbackQualities();
      qualitySelect.disabled = false;
      downloadBtn.disabled = false;
      if (addToQueueBtn) addToQueueBtn.disabled = false;
      status.textContent = "";
    }

  } catch (error) {
    console.error("Error getting video info:", error);
    videoTitleElement.textContent = "Error loading video info";
    downloadBtn.disabled = true;
  }
}

function populateFallbackQualities() {
  qualitySelect.innerHTML = "";
  // Show "Loading..." as first option while fetching real qualities
  const loadingOption = document.createElement("option");
  loadingOption.value = JSON.stringify({ height: 720, codec: "", isLoading: true });
  loadingOption.textContent = "Loading qualities...";
  loadingOption.disabled = true;
  loadingOption.selected = true;
  qualitySelect.appendChild(loadingOption);
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
    status.textContent = "Starting playlist download...";
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
    status.textContent = "Downloading...";
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
  
  // Update badge count
  if (queueBadge) {
    queueBadge.textContent = downloadQueue.length;
    queueBadge.classList.toggle("empty", downloadQueue.length === 0);
  }
  
  // Show/hide empty state
  if (queueEmpty) {
    queueEmpty.classList.toggle("hidden", downloadQueue.length > 0);
  }
  
  // Update stats
  const completed = downloadQueue.filter(i => i.status === "completed").length;
  const pending = downloadQueue.filter(i => i.status === "pending").length;
  const downloading = downloadQueue.filter(i => i.status === "downloading").length;
  const failed = downloadQueue.filter(i => i.status === "failed").length;
  
  if (queueStats && queueFooter) {
    if (downloadQueue.length > 0) {
      const parts = [];
      if (downloading > 0) parts.push(`${downloading} downloading`);
      if (pending > 0) parts.push(`${pending} waiting`);
      if (completed > 0) parts.push(`${completed} done`);
      if (failed > 0) parts.push(`${failed} failed`);
      queueStats.textContent = parts.join(" • ");
      queueFooter.classList.add("visible");
    } else {
      queueFooter.classList.remove("visible");
    }
  }
  
  // Render queue items
  queueList.innerHTML = "";
  
  for (const item of downloadQueue) {
    const itemEl = document.createElement("div");
    itemEl.className = `queue-item ${item.status}`;
    itemEl.dataset.id = item.id;
    
    const thumbnailUrl = item.thumbnail || 
      (item.videoId ? `https://img.youtube.com/vi/${item.videoId}/default.jpg` : "");
    
    let statusIcon = "";
    let statusText = "";
    let statusClass = item.status;
    switch (item.status) {
      case "pending":
        statusIcon = "⏸";
        statusText = "Queued";
        break;
      case "downloading":
        statusIcon = "●";
        statusText = "Downloading...";
        break;
      case "completed":
        statusIcon = "✓";
        statusText = "Completed";
        break;
      case "failed":
        statusIcon = "✕";
        statusText = item.error ? `Failed: ${item.error.substring(0, 20)}` : "Failed";
        break;
      default:
        statusIcon = "?";
        statusText = "Unknown";
        statusClass = "pending";
    }
    
    // Truncate title if too long
    const truncatedTitle = item.title.length > 35 
      ? item.title.substring(0, 35) + "..." 
      : item.title;
    
    itemEl.innerHTML = `
      ${thumbnailUrl ? `<img class="queue-item-thumbnail" src="${thumbnailUrl}" alt="">` : ""}
      <div class="queue-item-info">
        <div class="queue-item-title" title="${item.title}">${truncatedTitle}</div>
        <div class="queue-item-details">
          <span class="queue-item-quality">${item.qualityLabel || "720p"}</span>
          ${item.channel ? `<span>${item.channel}</span>` : ""}
        </div>
      </div>
      <span class="queue-item-status ${statusClass}">${statusIcon} ${statusText}</span>
      <div class="queue-item-actions">
        <button class="queue-item-remove" title="Remove" data-id="${item.id}">×</button>
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
    renderQueue();
  }
});

// Load queue from browser storage (for collapsed state)
async function loadQueueFromStorage() {
  try {
    logUI("Loading queue settings from storage...");
    const data = await browser.storage.local.get(["queueCollapsed"]);
    
    // Restore collapsed state
    if (data.queueCollapsed !== undefined) {
      queueCollapsed = data.queueCollapsed;
      logUI("Queue collapsed state:", queueCollapsed);
      if (queueListContainer) {
        queueListContainer.classList.toggle("collapsed", queueCollapsed);
      }
      if (toggleQueueBtn) {
        toggleQueueBtn.classList.toggle("collapsed", queueCollapsed);
      }
    }
    
    // Load actual queue from background script
    await loadQueueFromBackground();
  } catch (e) {
    logError("Error loading queue settings:", { message: e.message });
    renderQueue();
  }
}

// Toggle queue collapse
function toggleQueue() {
  queueCollapsed = !queueCollapsed;
  if (queueListContainer) {
    queueListContainer.classList.toggle("collapsed", queueCollapsed);
  }
  if (toggleQueueBtn) {
    toggleQueueBtn.classList.toggle("collapsed", queueCollapsed);
  }
  // Save collapsed state
  browser.storage.local.set({ queueCollapsed: queueCollapsed }).catch(console.error);
}

// Event listeners for queue
if (queueEnabled) {
  logUI("Setting up queue event listeners...");
  
  addToQueueBtn.addEventListener("click", addToQueue);
  
  if (clearQueueBtn) {
    clearQueueBtn.addEventListener("click", clearCompletedFromQueue);
  }
  
  if (toggleQueueBtn) {
    toggleQueueBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleQueue();
    });
  }
  
  // Click header to toggle (except buttons)
  const queueHeader = document.getElementById("queue-header");
  if (queueHeader) {
    queueHeader.addEventListener("click", (e) => {
      if (e.target.tagName !== "BUTTON" && !e.target.closest("button")) {
        toggleQueue();
      }
    });
  }
  
  logSuccess("Queue event listeners ready");
  
  // Load queue on popup open
  loadQueueFromStorage();
} else {
  logWarn("Queue UI elements not found - queue disabled");
  // Hide queue section if elements are missing
  if (queueSection) {
    queueSection.style.display = "none";
  }
}

// ==================== LOG CONTROLS ====================
const exportLogsBtn = document.getElementById("export-logs-btn");
const clearLogsBtn = document.getElementById("clear-logs-btn");
const logCountEl = document.getElementById("log-count");

// Update log count display
async function updateLogCount() {
  const count = await getLogCount();
  if (logCountEl) {
    logCountEl.textContent = count;
  }
}

// Set up log control event listeners
if (exportLogsBtn) {
  exportLogsBtn.addEventListener("click", async () => {
    exportLogsBtn.disabled = true;
    exportLogsBtn.textContent = "📤 Exporting...";
    const result = await exportLogs();
    exportLogsBtn.disabled = false;
    exportLogsBtn.textContent = "📤 Export";
    if (result.success) {
      status.textContent = "Logs exported!";
      status.style.color = "#4CAF50";
      setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 2000);
    }
  });
}

if (clearLogsBtn) {
  clearLogsBtn.addEventListener("click", async () => {
    if (confirm("Clear all logs? This cannot be undone.")) {
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

logInfo("Loading video info...");
loadVideoInfo();