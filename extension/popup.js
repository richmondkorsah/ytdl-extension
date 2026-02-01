const downloadBtn = document.getElementById("download-btn");
const qualitySelect = document.getElementById("quality-select");
const status = document.getElementById("status");
const videoTitleElement = document.getElementById("video-title");
const channelNameElement = document.getElementById("channel-name");
const videoDurationElement = document.getElementById("video-duration");
const thumbnailImg = document.getElementById("thumbnail-img");

const SERVER_URL = "http://localhost:5000";

let currentVideoInfo = null;
let availableQualities = [];

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

    if (!tab.url.includes("youtube.com/watch")) {
      videoTitleElement.textContent = "Not a YouTube video page";
      downloadBtn.disabled = true;
      return;
    }

    // Get basic info from content script first (for quick display)
    const contentResponse = await browser.tabs.sendMessage(tab.id, {
      type: "GET_VIDEO_INFO"
    });

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
    }

    // Now fetch actual available qualities from server
    const cleanUrl = cleanYouTubeUrl(tab.url);
    
    try {
      const infoResponse = await fetch(`${SERVER_URL}/info?url=${encodeURIComponent(cleanUrl)}`);
      const infoData = await infoResponse.json();
      
      if (infoData.success && infoData.available_qualities) {
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
          option.textContent = quality.label;  // Just show "720p", "1080p", etc.
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
    } catch (serverError) {
      console.error("Server error:", serverError);
      status.textContent = "Server not running. Start: python backend/server.py";
      status.style.color = "#f44336";
      populateFallbackQualities();
      qualitySelect.disabled = false;
      downloadBtn.disabled = false;
    }

  } catch (error) {
    console.error("Error getting video info:", error);
    videoTitleElement.textContent = "Error loading video info";
    downloadBtn.disabled = true;
  }
}

function populateFallbackQualities() {
  qualitySelect.innerHTML = "";
  const defaults = [
    { value: "1080", label: "1080p" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
    { value: "360", label: "360p" },
    { value: "audio", label: "Audio Only" }
  ];
  for (const q of defaults) {
    const option = document.createElement("option");
    option.value = q.value;
    option.textContent = q.label;
    if (q.value === "720") option.selected = true;
    qualitySelect.appendChild(option);
  }
}

downloadBtn.addEventListener("click", async () => {
  if (!currentVideoInfo) return;

  const selectedValue = qualitySelect.value;
  let qualityData;
  
  try {
    qualityData = JSON.parse(selectedValue);
  } catch {
    // Fallback format (old style)
    qualityData = { height: parseInt(selectedValue) || 0, codec: "", isAudio: selectedValue === "audio" };
  }
  
  // Immediately show downloading status
  status.textContent = "Downloading...";
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Downloading...";

  try {
    const response = await browser.runtime.sendMessage({
      type: "DOWNLOAD_VIDEO",
      url: currentVideoInfo.url,
      quality: qualityData,
      videoTitle: currentVideoInfo.videoTitle,
      channelName: currentVideoInfo.channelName
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
});

loadVideoInfo();
