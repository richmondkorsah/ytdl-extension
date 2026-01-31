const downloadBtn = document.getElementById("download-btn");
const qualitySelect = document.getElementById("quality-select");
const status = document.getElementById("status");
const videoTitleElement = document.getElementById("video-title");
const channelNameElement = document.getElementById("channel-name");
const videoDurationElement = document.getElementById("video-duration");
const thumbnailImg = document.getElementById("thumbnail-img");

let currentVideoInfo = null;

async function loadVideoInfo() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

    if (!tab.url.includes("youtube.com/watch")) {
      videoTitleElement.textContent = "Not a YouTube video page";
      downloadBtn.disabled = true;
      return;
    }

    const response = await browser.tabs.sendMessage(tab.id, {
      type: "GET_VIDEO_INFO"
    });

    if (!response) {
      videoTitleElement.textContent = "Unable to get video info";
      downloadBtn.disabled = true;
      return;
    }

    currentVideoInfo = response;
    videoTitleElement.textContent = response.videoTitle || "Unknown title";
    channelNameElement.textContent = response.channelName || "";
    videoDurationElement.textContent = response.duration || "";

    if (response.thumbnail) {
      thumbnailImg.src = response.thumbnail;
      thumbnailImg.alt = response.videoTitle;
    }

    // Populate quality dropdown with available qualities
    if (response.qualities && response.qualities.length > 0) {
      qualitySelect.innerHTML = "";
      for (const quality of response.qualities) {
        const option = document.createElement("option");
        option.value = quality.value;
        option.textContent = quality.label;
        // Default to 720p if available
        if (quality.value === "720") {
          option.selected = true;
        }
        qualitySelect.appendChild(option);
      }
    }

  } catch (error) {
    console.error("Error getting video info:", error);
    videoTitleElement.textContent = "Error loading video info";
    downloadBtn.disabled = true;
  }
}

downloadBtn.addEventListener("click", async () => {
  if (!currentVideoInfo) return;

  const quality = qualitySelect.value;
  
  // Immediately show downloading status
  status.textContent = "Downloading...";
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Downloading...";

  try {
    const response = await browser.runtime.sendMessage({
      type: "DOWNLOAD_VIDEO",
      url: currentVideoInfo.url,
      quality: quality
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
