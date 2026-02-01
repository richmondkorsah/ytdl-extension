const downloadBtn = document.getElementById("download-btn");
const qualitySelect = document.getElementById("quality-select");
const status = document.getElementById("status");
const videoTitleElement = document.getElementById("video-title");
const channelNameElement = document.getElementById("channel-name");
const videoDurationElement = document.getElementById("video-duration");
const thumbnailImg = document.getElementById("thumbnail-img");
const subtitleCheckbox = document.getElementById("subtitle-checkbox");
const subtitleLang = document.getElementById("subtitle-lang");

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
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

    // Check if it's a playlist page
    const playlistId = extractPlaylistId(tab.url);
    const videoId = extractVideoId(tab.url);
    
    // Playlist page (not watching a video in playlist)
    if (tab.url.includes("youtube.com/playlist") && playlistId) {
      await loadPlaylistInfo(tab.url, playlistId);
      return;
    }
    
    // Video page (may or may not be part of a playlist)
    if (!tab.url.includes("youtube.com/watch")) {
      videoTitleElement.textContent = "Not a YouTube video page";
      downloadBtn.disabled = true;
      return;
    }

    // Show video mode UI
    isPlaylistMode = false;
    playlistContainer.style.display = "none";
    videoContainer.style.display = "block";
    downloadBtn.textContent = "Download";

    // Show loading state in dropdown while fetching qualities
    populateFallbackQualities();
    qualitySelect.disabled = true;
    downloadBtn.disabled = true;

    // Get basic info from content script first (for quick display)
    let contentResponse = null;
    try {
      contentResponse = await browser.tabs.sendMessage(tab.id, {
        type: "GET_VIDEO_INFO"
      });
    } catch (e) {
      console.log("Content script not ready yet");
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
        const cachedInfo = await browser.runtime.sendMessage({
          type: "GET_CACHED_INFO",
          videoId: videoId
        });
        if (cachedInfo && cachedInfo.success) {
          console.log("Using cached video info!");
          infoData = cachedInfo;
        }
      } catch (e) {
        console.log("No cached info available");
      }
    }

    // If no cached info, fetch from server
    if (!infoData) {
      const cleanUrl = cleanYouTubeUrl(tab.url);
      try {
        status.textContent = "Loading qualities...";
        const infoResponse = await fetch(`${SERVER_URL}/info?url=${encodeURIComponent(cleanUrl)}`);
        infoData = await infoResponse.json();
      } catch (serverError) {
        console.error("Server error:", serverError);
        status.textContent = "Server not running. Start: python backend/server.py";
        status.style.color = "#f44336";
        populateFallbackQualities();
        qualitySelect.disabled = false;
        downloadBtn.disabled = false;
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
      status.textContent = "";
    } else {
      // Fallback to default qualities if server fetch fails
      console.warn("Could not fetch qualities from server, using defaults");
      populateFallbackQualities();
      qualitySelect.disabled = false;
      downloadBtn.disabled = false;
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
    if (!currentPlaylistInfo) return;
    
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
        status.textContent = "Playlist download started! Check your downloads.";
        status.style.color = "#4CAF50";
      } else {
        throw new Error(response.error || "Download failed");
      }
    } catch (error) {
      console.error("Playlist download error:", error);
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
    if (!currentVideoInfo) return;
    
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
        status.textContent = "Download started! Check your downloads.";
        status.style.color = "#4CAF50";
      } else {
        throw new Error(response.error || "Download failed");
      }
    } catch (error) {
      console.error("Download error:", error);
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

loadVideoInfo();
