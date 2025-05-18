// netlify/functions/scheduled-video-fetch.js
const fetch = require('node-fetch');

// These will come from Netlify Environment Variables
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Configuration specific to the scheduled task (from environment variables)
const CHANNELS_CONFIG_JSON = process.env.SCHEDULED_USER_CHANNELS_CONFIG;
const TARGET_PLAYLIST_ID = process.env.SCHEDULED_USER_TARGET_PLAYLIST_ID;
let YOUTUBE_ACCESS_TOKEN = process.env.SCHEDULED_USER_YOUTUBE_ACCESS_TOKEN; // Might be initially undefined or stale, will be refreshed
const YOUTUBE_REFRESH_TOKEN = process.env.SCHEDULED_USER_YOUTUBE_REFRESH_TOKEN;

// Helper to parse ISO 8601 duration (same as in your youtube-api.js)
function parseISO8601Duration(isoDuration) {
    if (!isoDuration) return 0;
    const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
    const matches = isoDuration.match(regex);
    if (!matches) return 0;
    const hours = parseInt(matches[1] || 0);
    const minutes = parseInt(matches[2] || 0);
    const seconds = parseInt(matches[3] || 0);
    return (hours * 3600) + (minutes * 60) + seconds;
}

// Helper function to refresh the YouTube Access Token
async function refreshAccessToken() {
    console.log("[Scheduled Fetch] Attempting to refresh YouTube access token...");
    if (!YOUTUBE_REFRESH_TOKEN) {
        console.error("[Scheduled Fetch] Error: Critical - Missing YOUTUBE_REFRESH_TOKEN for scheduled task.");
        throw new Error("Refresh token is missing for scheduled task. Cannot proceed.");
    }
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        console.error("[Scheduled Fetch] Error: Critical - Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET for token refresh.");
        throw new Error("Client ID or Secret is missing for token refresh. Cannot proceed.");
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: YOUTUBE_REFRESH_TOKEN,
            grant_type: 'refresh_token',
        }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error("[Scheduled Fetch] Google token refresh error:", errorData);
        // If refresh token is invalid, this is a critical failure for the scheduled task
        if (response.status === 400 || response.status === 401) { // Common statuses for invalid refresh token
             console.error("[Scheduled Fetch] CRITICAL: Refresh token may be invalid or revoked. Manual update of SCHEDULED_USER_YOUTUBE_REFRESH_TOKEN environment variable required.");
        }
        throw new Error(`Failed to refresh token: ${errorData.error_description || response.statusText}`);
    }

    const tokenData = await response.json();
    YOUTUBE_ACCESS_TOKEN = tokenData.access_token; // Update the global access token for this run
    console.log("[Scheduled Fetch] YouTube access token refreshed successfully.");
    // Note: Google might also send a new refresh_token (tokenData.refresh_token).
    // A more robust system would update the stored refresh token if a new one is provided.
    // For this version, we assume the initial YOUTUBE_REFRESH_TOKEN remains valid for a long time.
}

// Helper to call YouTube API (adapted for scheduled task)
async function callYouTubeApi(endpoint, method = 'GET', body = null, useApiKey = false) {
    const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
    const headers = { 'Accept': 'application/json' };
    let finalEndpoint = endpoint; // Keep original endpoint for logging

    if (useApiKey) {
        if (!YOUTUBE_API_KEY) {
            console.error("[Scheduled Fetch] Error: YOUTUBE_API_KEY is missing for an API key based call.");
            throw new Error("YOUTUBE_API_KEY is missing.");
        }
        // Add API key to the endpoint URL
        finalEndpoint = endpoint.includes('?') ? `${endpoint}&key=${YOUTUBE_API_KEY}` : `${endpoint}?key=${YOUTUBE_API_KEY}`;
    } else {
        if (!YOUTUBE_ACCESS_TOKEN) {
            console.error("[Scheduled Fetch] Error: YOUTUBE_ACCESS_TOKEN is missing for an authenticated call.");
            throw new Error("Missing YouTube Access Token for API call. Attempt refresh first.");
        }
        headers['Authorization'] = `Bearer ${YOUTUBE_ACCESS_TOKEN}`;
    }

    if (method === 'POST' || method === 'PUT') {
        headers['Content-Type'] = 'application/json';
    }

    const options = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    console.log(`[Scheduled Fetch] Calling YouTube API: ${method} ${YOUTUBE_API_BASE}${finalEndpoint.startsWith('/') ? '' : '/'}${finalEndpoint.split('key=')[0] + (finalEndpoint.includes('key=') ? 'key=******' : '')}`);


    const response = await fetch(`${YOUTUBE_API_BASE}${finalEndpoint.startsWith('/') ? '' : '/'}${finalEndpoint}`, options); // Ensure leading / if endpoint doesn't have one
    if (!response.ok) {
        const errorData = await response.json();
        const errorMessage = errorData.error?.message || response.statusText || 'Unknown API error';
        console.error(`[Scheduled Fetch] YouTube API Error (${method} ${endpoint}):`, errorMessage, "Status:", response.status, "Details:", JSON.stringify(errorData));
        throw new Error(`YouTube API request failed for ${endpoint}: ${errorMessage} (Status: ${response.status})`);
    }
    return response.json();
}

// Main handler for the scheduled function
exports.handler = async (event, context) => {
    console.log("[Scheduled Fetch] Starting scheduled video fetch job at", new Date().toUTCString());

    // Basic check for essential configurations
    if (!CHANNELS_CONFIG_JSON || !TARGET_PLAYLIST_ID || !YOUTUBE_REFRESH_TOKEN || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !YOUTUBE_API_KEY) {
        console.error("[Scheduled Fetch] CRITICAL Error: Missing one or more essential environment variables. Aborting scheduled task.");
        return { statusCode: 500, body: "Scheduled task configuration error: Essential environment variables missing." };
    }

    let channelsConfig;
    try {
        channelsConfig = JSON.parse(CHANNELS_CONFIG_JSON);
        if (!Array.isArray(channelsConfig)) throw new Error("CHANNELS_CONFIG_JSON is not an array.");
    } catch (e) {
        console.error("[Scheduled Fetch] CRITICAL Error parsing CHANNELS_CONFIG_JSON:", e.message, ". Ensure it's a valid JSON array string. Value:", CHANNELS_CONFIG_JSON);
        return { statusCode: 500, body: "Invalid channels config JSON format." };
    }

    try {
        // 1. Refresh the Access Token (absolutely essential)
        await refreshAccessToken();

        // 2. Get current items in the target playlist to avoid duplicates
        let videoIdsCurrentlyInPlaylist = new Set();
        try {
            console.log(`[Scheduled Fetch] Fetching current items from playlist ID: ${TARGET_PLAYLIST_ID}`);
            let allPlaylistVideoItems = [];
            let nextPageToken = null;
            do {
                // PlaylistItems endpoint requires authentication (not API key)
                const playlistItemsData = await callYouTubeApi(`/playlistItems?part=snippet&playlistId=${TARGET_PLAYLIST_ID}&maxResults=50${nextPageToken ? '&pageToken='+nextPageToken : ''}`);
                if (playlistItemsData.items) {
                    allPlaylistVideoItems = allPlaylistVideoItems.concat(playlistItemsData.items.map(item => item.snippet.resourceId.videoId));
                }
                nextPageToken = playlistItemsData.nextPageToken;
            } while (nextPageToken);
            allPlaylistVideoItems.forEach(id => videoIdsCurrentlyInPlaylist.add(id));
            console.log(`[Scheduled Fetch] Found ${videoIdsCurrentlyInPlaylist.size} videos currently in playlist.`);
        } catch (error) {
            console.error("[Scheduled Fetch] Error fetching current playlist items:", error.message, ". Proceeding with empty current playlist for de-duplication for this run.");
            // If this fails, we rely only on not re-adding videos processed in *this current run*.
        }

        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3); // Look for videos in the last 3 days
        const publishedAfterDate = threeDaysAgo.toISOString();
        let allNewVideosForPlaylist = [];

        for (const channel of channelsConfig) {
            console.log(`[Scheduled Fetch] Processing channel: ${channel.channelId} with keywords: "${channel.keywords || 'Any'}"`);
            try {
                // Step A: Search for videos (uses API Key)
                let searchUrl = `/search?part=snippet&channelId=${channel.channelId}&order=date&type=video&maxResults=25&publishedAfter=${publishedAfterDate}`; // MaxResults up to 50
                const searchData = await callYouTubeApi(searchUrl, 'GET', null, true);

                if (!searchData.items || searchData.items.length === 0) {
                    console.log(`[Scheduled Fetch] No recent videos found from search for channel ${channel.channelId}.`);
                    continue;
                }
                const videoIdsFromSearch = searchData.items.map(item => item.id.videoId).filter(id => id); // Filter out undefined IDs
                if (videoIdsFromSearch.length === 0) {
                    console.log(`[Scheduled Fetch] No valid video IDs from search for channel ${channel.channelId}.`);
                    continue;
                }

                // Step B: Get details for duration (uses API Key)
                const detailsUrl = `/videos?part=snippet,contentDetails&id=${videoIdsFromSearch.join(',')}`;
                const detailedData = await callYouTubeApi(detailsUrl, 'GET', null, true);
                
                let fetchedVideos = detailedData.items ? detailedData.items.map(item => ({
                    id: item.id,
                    title: item.snippet.title,
                    description: item.snippet.description,
                    publishedAt: item.snippet.publishedAt,
                    thumbnail: item.snippet.thumbnails.default.url, // Simplified
                    duration: item.contentDetails.duration
                })) : [];

                // Step C: Apply filters
                // Positive Keywords
                if (channel.keywords && channel.keywords.trim() !== "") {
                    const keywordArray = channel.keywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k);
                    fetchedVideos = fetchedVideos.filter(video =>
                        keywordArray.some(keyword =>
                            (video.title && video.title.toLowerCase().includes(keyword)) ||
                            (video.description && video.description.toLowerCase().includes(keyword))
                        )
                    );
                }
                // Negative Keywords
                if (channel.negativeKeywords && channel.negativeKeywords.trim() !== "") {
                    const negKeywordArray = channel.negativeKeywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k);
                    fetchedVideos = fetchedVideos.filter(video =>
                        !negKeywordArray.some(negKeyword =>
                            (video.title && video.title.toLowerCase().includes(negKeyword)) ||
                            (video.description && video.description.toLowerCase().includes(negKeyword))
                        )
                    );
                }
                // Duration
                if (typeof channel.minDuration === 'number' || typeof channel.maxDuration === 'number') {
                    fetchedVideos = fetchedVideos.filter(video => {
                        const durationInMinutes = parseISO8601Duration(video.duration) / 60;
                        const passesMin = (typeof channel.minDuration !== 'number' || durationInMinutes >= channel.minDuration);
                        const passesMax = (typeof channel.maxDuration !== 'number' || durationInMinutes <= channel.maxDuration);
                        return passesMin && passesMax;
                    });
                }
                
                console.log(`[Scheduled Fetch] Channel ${channel.channelId}: ${fetchedVideos.length} videos after all filters.`);

                fetchedVideos.forEach(video => {
                    if (!videoIdsCurrentlyInPlaylist.has(video.id)) {
                        allNewVideosForPlaylist.push(video);
                        videoIdsCurrentlyInPlaylist.add(video.id); // Add to set to avoid duplicate from another channel config in THIS run
                    } else {
                         console.log(`[Scheduled Fetch] Skipping (already in playlist or processed this run): "${video.title}" (ID: ${video.id})`);
                    }
                });

            } catch (channelError) {
                console.error(`[Scheduled Fetch] Error processing channel ${channel.channelId}:`, channelError.message, channelError.stack);
                // Continue to the next channel even if one fails
            }
        }

        if (allNewVideosForPlaylist.length > 0) {
            allNewVideosForPlaylist.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt)); // Oldest first
            console.log(`[Scheduled Fetch] Adding ${allNewVideosForPlaylist.length} new unique videos to playlist ${TARGET_PLAYLIST_ID}.`);

            for (const video of allNewVideosForPlaylist) {
                try {
                    // Adding to playlist requires authentication (not API key)
                    await callYouTubeApi(`/playlistItems?part=snippet`, 'POST', {
                        snippet: {
                            playlistId: TARGET_PLAYLIST_ID,
                            position: 0, // Add to the top
                            resourceId: { kind: "youtube#video", videoId: video.id }
                        }
                    });
                    console.log(`[Scheduled Fetch] Successfully added "${video.title}" (ID: ${video.id}) to playlist.`);
                } catch (addError) {
                    console.error(`[Scheduled Fetch] Error adding video "${video.title}" (ID: ${video.id}) to playlist:`, addError.message);
                    // If adding one video fails, continue to try adding others
                }
            }
        } else {
            console.log("[Scheduled Fetch] No new unique videos to add to the playlist this time.");
        }

        console.log("[Scheduled Fetch] Scheduled video fetch job completed at", new Date().toUTCString());
        return { statusCode: 200, body: "Scheduled task executed successfully." };

    } catch (error) {
        console.error("[Scheduled Fetch] CRITICAL Error in scheduled task main execution:", error.message, error.stack);
        return { statusCode: 500, body: `Scheduled task failed: ${error.message}` };
    }
};