function getVideoId() {
    const url = new URL(window.location.href);
    return url.searchParams.get("v");
}

function getAvailableQualities() {
    return new Promise((resolve) => {
        // Inject a script to access the page's global variables
        const script = document.createElement('script');
        script.textContent = `
            (function() {
                let qualities = [];
                try {
                    if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.streamingData) {
                        const formats = [
                            ...(window.ytInitialPlayerResponse.streamingData.formats || []),
                            ...(window.ytInitialPlayerResponse.streamingData.adaptiveFormats || [])
                        ];
                        
                        const qualitySet = new Set();
                        for (const format of formats) {
                            if (format.height && !qualitySet.has(format.height)) {
                                qualitySet.add(format.height);
                                qualities.push({
                                    value: String(format.height),
                                    label: format.qualityLabel || format.height + 'p'
                                });
                            }
                        }
                        qualities.sort((a, b) => parseInt(b.value) - parseInt(a.value));
                    }
                } catch(e) {}
                
                window.postMessage({ type: 'YT_QUALITIES', qualities: qualities }, '*');
            })();
        `;
        document.documentElement.appendChild(script);
        script.remove();

        // Listen for the response
        const handler = (event) => {
            if (event.data && event.data.type === 'YT_QUALITIES') {
                window.removeEventListener('message', handler);
                let qualities = event.data.qualities;
                
                if (qualities.length > 0) {
                    qualities.unshift({ value: "best", label: "Best Quality" });
                    qualities.push({ value: "audio", label: "Audio Only" });
                    resolve(qualities);
                } else {
                    // Fallback
                    resolve([
                        { value: "best", label: "Best Quality" },
                        { value: "1080", label: "1080p" },
                        { value: "720", label: "720p" },
                        { value: "480", label: "480p" },
                        { value: "360", label: "360p" },
                        { value: "audio", label: "Audio Only" }
                    ]);
                }
            }
        };
        
        window.addEventListener('message', handler);
        
        // Timeout fallback
        setTimeout(() => {
            window.removeEventListener('message', handler);
            resolve([
                { value: "best", label: "Best Quality" },
                { value: "1080", label: "1080p" },
                { value: "720", label: "720p" },
                { value: "480", label: "480p" },
                { value: "360", label: "360p" },
                { value: "audio", label: "Audio Only" }
            ]);
        }, 1000);
    });
}

async function getVideoInfo() {
    const videoId = getVideoId();
    if (!videoId) return null;

    const h1 = document.querySelector("h1.ytd-watch-metadata");
    const videoTitle =
        h1?.innerText.trim() ||
        document.title.replace(" - YouTube", "") ||
        "Unknown title";

    const channelElement = document.querySelector("ytd-channel-name yt-formatted-string a");
    const channelName = channelElement?.innerText.trim() || "Unknown channel";

    // Get video duration from the player
    const durationElement = document.querySelector(".ytp-time-duration");
    const duration = durationElement?.innerText.trim() || "";

    // Get video view count
    let views = null;
    try {
        // Method 1: Try DOM selectors (YouTube updates these, so try multiple)
        const viewSelectors = [
            'ytd-watch-metadata #info span.bold.style-scope.yt-formatted-string',
            'ytd-video-primary-info-renderer .view-count',
            '#info-text .view-count',
            'ytd-watch-metadata ytd-video-view-count-renderer span.view-count',
            '#count ytd-video-view-count-renderer .view-count'
        ];
        for (const selector of viewSelectors) {
            const el = document.querySelector(selector);
            if (el) {
                const text = el.innerText.trim();
                const match = text.replace(/,/g, '').match(/(\d+)/);
                if (match) {
                    views = parseInt(match[1], 10);
                    break;
                }
            }
        }

        // Method 2: Try ytInitialPlayerResponse via page context injection
        if (!views) {
            const script = document.createElement('script');
            script.textContent = `
                (function() {
                    let vc = null;
                    try {
                        vc = window.ytInitialPlayerResponse?.videoDetails?.viewCount;
                        if (!vc) {
                            const contents = window.ytInitialData?.contents?.twoColumnWatchNextResults
                                ?.results?.results?.contents;
                            if (contents) {
                                for (const c of contents) {
                                    const vcr = c.videoPrimaryInfoRenderer?.viewCount
                                        ?.videoViewCountRenderer?.viewCount?.simpleText;
                                    if (vcr) { vc = vcr; break; }
                                }
                            }
                        }
                    } catch(e) {}
                    window.postMessage({ type: 'YT_VIEW_COUNT', viewCount: vc }, '*');
                })();
            `;
            document.documentElement.appendChild(script);
            script.remove();

            views = await new Promise((resolve) => {
                const handler = (event) => {
                    if (event.data && event.data.type === 'YT_VIEW_COUNT') {
                        window.removeEventListener('message', handler);
                        const vc = event.data.viewCount;
                        if (vc) {
                            const num = parseInt(String(vc).replace(/[^0-9]/g, ''), 10);
                            resolve(isNaN(num) ? null : num);
                        } else {
                            resolve(null);
                        }
                    }
                };
                window.addEventListener('message', handler);
                setTimeout(() => {
                    window.removeEventListener('message', handler);
                    resolve(null);
                }, 500);
            });
        }
    } catch(e) {}

    const thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;  // More reliable than maxresdefault
    const qualities = await getAvailableQualities();

    return {
        url: window.location.href,
        videoId,
        videoTitle,
        channelName,
        duration,
        views,
        thumbnail,
        qualities
    };
}

browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "GET_VIDEO_INFO") {
        return waitForTitle().then(() => getVideoInfo());
    }
});

function waitForTitle(timeout = 5000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const interval = setInterval(() => {
            const h1 = document.querySelector("h1.ytd-watch-metadata");
            if (h1 && h1.innerText.trim()) {
                clearInterval(interval);
                resolve();
            }
            if (Date.now() - start > timeout) {
                clearInterval(interval);
                resolve();
            }
        }, 200);
    });
}

// Optional: log title changes (for SPA navigation)
const observer = new MutationObserver(() => {
    const h1 = document.querySelector("h1.ytd-watch-metadata");
    if (h1) {
        console.log("Title changed:", h1.innerText);
    }
});

observer.observe(document.body, { childList: true, subtree: true });

// Immediately trigger prefetch when content script loads on a YouTube video page
(function triggerPrefetch() {
    const videoId = getVideoId();
    if (videoId) {
        console.log("Content script: triggering prefetch for", videoId);
        browser.runtime.sendMessage({
            type: "PREFETCH_INFO",
            url: window.location.href,
            videoId: videoId
        }).catch(() => {
            // Background script might not be ready yet, that's ok
        });
    }
})();

// Also trigger prefetch on YouTube SPA navigation
let lastVideoId = getVideoId();
const navObserver = new MutationObserver(() => {
    const currentVideoId = getVideoId();
    if (currentVideoId && currentVideoId !== lastVideoId) {
        lastVideoId = currentVideoId;
        console.log("Content script: SPA navigation detected, prefetching", currentVideoId);
        browser.runtime.sendMessage({
            type: "PREFETCH_INFO",
            url: window.location.href,
            videoId: currentVideoId
        }).catch(() => {});
    }
});

navObserver.observe(document.body, { childList: true, subtree: true });