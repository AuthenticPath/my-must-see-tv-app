// netlify/functions/scheduled-video-fetch.js
const fetch = require('node-fetch'); // For YouTube API calls
const { Firestore } = require('@google-cloud/firestore'); // For Firestore

// These will come from Netlify Environment Variables
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// --- REMOVED: CHANNELS_CONFIG_JSON from env, we'll load it from Firestore ---
// const CHANNELS_CONFIG_JSON = process.env.SCHEDULED_USER_CHANNELS_CONFIG; 

const TARGET_PLAYLIST_ID = process.env.SCHEDULED_USER_TARGET_PLAYLIST_ID;
let YOUTUBE_ACCESS_TOKEN = process.env.SCHEDULED_USER_YOUTUBE_ACCESS_TOKEN;
const YOUTUBE_REFRESH_TOKEN = process.env.SCHEDULED_USER_YOUTUBE_REFRESH_TOKEN;

// Initialize Firestore (same as in user-settings.js)
// --- MODIFIED Firestore Initialization in scheduled-video-fetch.js ---
let firestore;
try {
    const projectId = process.env.GCP_PROJECT_ID;
    const clientEmail = process.env.GCP_CLIENT_EMAIL;
    // The private key from env var might have literal '\n' which need to be actual newlines.
    const privateKey = process.env.GCP_PRIVATE_KEY ? process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined;

    if (!projectId || !clientEmail || !privateKey) {
        console.warn("[Scheduled Fetch] Missing one or more GCP credential environment variables (GCP_PROJECT_ID, GCP_CLIENT_EMAIL, GCP_PRIVATE_KEY). Firestore might not initialize correctly in deployed env.");
        // Attempt to initialize without explicit credentials for local gcloud CLI auth
        firestore = new Firestore();
    } else {
        firestore = new Firestore({
            projectId: projectId,
            credentials: {
                client_email: clientEmail,
                private_key: privateKey,
            },
        });
        console.log("[Scheduled Fetch] Firestore initialized with split service account credentials.");
    }
} catch (error) {
    console.error("[Scheduled Fetch] CRITICAL ERROR initializing Firestore:", error.message, error.stack);
    throw new Error("Firestore initialization failed for scheduled fetch. Check GCP credential environment variables.");
}
// --- END OF MODIFIED BLOCK ---

// Firestore constants (same as in user-settings.js)
const SETTINGS_COLLECTION = 'userAppSettings';
const CONFIG_DOCUMENT_ID = 'mainConfiguration';

// Helper to parse ISO 8601 duration (same as before)
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

// Helper function to refresh the YouTube Access Token (same as before)
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
        if (response.status === 400 || response.status === 401) {
             console.error("[Scheduled Fetch] CRITICAL: Refresh token may be invalid or revoked. Manual update of SCHEDULED_USER_YOUTUBE_REFRESH_TOKEN environment variable required.");
        }
        throw new Error(`Failed to refresh token: ${errorData.error_description || response.statusText}`);
    }

    const tokenData = await response.json();
    YOUTUBE_ACCESS_TOKEN = tokenData.access_token;
    console.log("[Scheduled Fetch] YouTube access token refreshed successfully.");
}

// Helper to call YouTube API (same as before)
async function callYouTubeApi(endpoint, method = 'GET', body = null, useApiKey = false) {
    const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
    const headers = { 'Accept': 'application/json' };
    let finalEndpoint = endpoint;

    if (useApiKey) {
        if (!YOUTUBE_API_KEY) {
            console.error("[Scheduled Fetch] Error: YOUTUBE_API_KEY is missing for an API key based call.");
            throw new Error("YOUTUBE_API_KEY is missing.");
        }
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

    const response = await fetch(`${YOUTUBE_API_BASE}${finalEndpoint.startsWith('/') ? '' : '/'}${finalEndpoint}`, options);
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

    // Basic check for essential configurations (TARGET_PLAYLIST_ID etc. still needed from env)
    if (!TARGET_PLAYLIST_ID || !YOUTUBE_REFRESH_TOKEN || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !YOUTUBE_API_KEY || !process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS) {
        console.error("[Scheduled Fetch] CRITICAL Error: Missing one or more essential environment variables (excluding channels config). Aborting scheduled task.");
        return { statusCode: 500, body: "Scheduled task configuration error: Essential environment variables missing." };
    }

    let channelsConfig; // This will be populated from Firestore

    try {
        // 0. Initialize Firestore client (moved to top level for clarity, already done)

        // 1. Load Channel Configuration from Firestore
        console.log(`[Scheduled Fetch] Attempting to load channel configuration from Firestore: Collection='${SETTINGS_COLLECTION}', Document='${CONFIG_DOCUMENT_ID}'`);
        const configDocRef = firestore.collection(SETTINGS_COLLECTION).doc(CONFIG_DOCUMENT_ID);
        const configDoc = await configDocRef.get();

        if (!configDoc.exists) {
            console.error(`[Scheduled Fetch] CRITICAL Error: Configuration document '${CONFIG_DOCUMENT_ID}' does not exist in Firestore collection '${SETTINGS_COLLECTION}'. Please save settings from the app UI first.`);
            return { statusCode: 500, body: "Channel configuration not found in Firestore." };
        }
        
        const configData = configDoc.data();
        if (!configData || !Array.isArray(configData.channels)) {
             console.error(`[Scheduled Fetch] CRITICAL Error: 'channels' field is missing or not an array in Firestore document '${CONFIG_DOCUMENT_ID}'. Data:`, configData);
             return { statusCode: 500, body: "Invalid channel configuration format in Firestore." };
        }
        channelsConfig = configData.channels; // Get the array of channels
        console.log(`[Scheduled Fetch] Successfully loaded ${channelsConfig.length} channel configurations from Firestore.`);
        if (channelsConfig.length === 0) {
            console.log("[Scheduled Fetch] No channels configured in Firestore. Nothing to process.");
            return { statusCode: 200, body: "No channels configured. Task ended." };
        }

        // 2. Refresh the Access Token (absolutely essential)
        await refreshAccessToken();

        // 3. Get current items in the target playlist to avoid duplicates (same as before)
        let videoIdsCurrentlyInPlaylist = new Set();
        try {
            console.log(`[Scheduled Fetch] Fetching current items from playlist ID: ${TARGET_PLAYLIST_ID}`);
            let allPlaylistVideoItems = [];
            let nextPageToken = null;
            do {
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
        }

        // --- The rest of the logic (fetching videos, filtering, adding to playlist) remains largely the same ---
        // --- It will now use the 'channelsConfig' loaded from Firestore ---

        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        const publishedAfterDate = threeDaysAgo.toISOString();
        let allNewVideosForPlaylist = [];

        for (const channel of channelsConfig) { // Using channelsConfig from Firestore
            console.log(`[Scheduled Fetch] Processing channel: ${channel.channelId} with keywords: "${channel.keywords || 'Any'}"`);
            try {
                let searchUrl = `/search?part=snippet&channelId=${channel.channelId}&order=date&type=video&maxResults=25&publishedAfter=${publishedAfterDate}`;
                const searchData = await callYouTubeApi(searchUrl, 'GET', null, true);

                if (!searchData.items || searchData.items.length === 0) {
                    console.log(`[Scheduled Fetch] No recent videos found from search for channel ${channel.channelId}.`);
                    continue;
                }
                const videoIdsFromSearch = searchData.items.map(item => item.id.videoId).filter(id => id);
                if (videoIdsFromSearch.length === 0) {
                    console.log(`[Scheduled Fetch] No valid video IDs from search for channel ${channel.channelId}.`);
                    continue;
                }

                const detailsUrl = `/videos?part=snippet,contentDetails&id=${videoIdsFromSearch.join(',')}`;
                const detailedData = await callYouTubeApi(detailsUrl, 'GET', null, true);
                
                let fetchedVideos = detailedData.items ? detailedData.items.map(item => ({
                    id: item.id,
                    title: item.snippet.title,
                    description: item.snippet.description,
                    publishedAt: item.snippet.publishedAt,
                    thumbnail: item.snippet.thumbnails.default.url,
                    duration: item.contentDetails.duration
                })) : [];

                // Filters (Positive Keywords, Negative Keywords, Duration)
                if (channel.keywords && channel.keywords.trim() !== "") { /* ... same filter logic ... */ 
                    const keywordArray = channel.keywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k);
                    fetchedVideos = fetchedVideos.filter(video =>
                        keywordArray.some(keyword =>
                            (video.title && video.title.toLowerCase().includes(keyword)) ||
                            (video.description && video.description.toLowerCase().includes(keyword))
                        )
                    );
                }
                if (channel.negativeKeywords && channel.negativeKeywords.trim() !== "") { /* ... same filter logic ... */
                    const negKeywordArray = channel.negativeKeywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k);
                    fetchedVideos = fetchedVideos.filter(video =>
                        !negKeywordArray.some(negKeyword =>
                            (video.title && video.title.toLowerCase().includes(negKeyword)) ||
                            (video.description && video.description.toLowerCase().includes(negKeyword))
                        )
                    );
                }
                if (typeof channel.minDuration === 'number' || typeof channel.maxDuration === 'number') { /* ... same filter logic ... */
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
                        videoIdsCurrentlyInPlaylist.add(video.id);
                    } else {
                         console.log(`[Scheduled Fetch] Skipping (already in playlist or processed this run): "${video.title}" (ID: ${video.id})`);
                    }
                });

            } catch (channelError) {
                console.error(`[Scheduled Fetch] Error processing channel ${channel.channelId}:`, channelError.message, channelError.stack);
            }
        }

        if (allNewVideosForPlaylist.length > 0) {
            allNewVideosForPlaylist.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
            console.log(`[Scheduled Fetch] Adding ${allNewVideosForPlaylist.length} new unique videos to playlist ${TARGET_PLAYLIST_ID}.`);

            for (const video of allNewVideosForPlaylist) {
                try {
                    await callYouTubeApi(`/playlistItems?part=snippet`, 'POST', {
                        snippet: {
                            playlistId: TARGET_PLAYLIST_ID,
                            position: 0,
                            resourceId: { kind: "youtube#video", videoId: video.id }
                        }
                    });
                    console.log(`[Scheduled Fetch] Successfully added "${video.title}" (ID: ${video.id}) to playlist.`);
                } catch (addError) {
                    console.error(`[Scheduled Fetch] Error adding video "${video.title}" (ID: ${video.id}) to playlist:`, addError.message);
                }
            }
        } else {
            console.log("[Scheduled Fetch] No new unique videos to add to the playlist this time.");
        }

        console.log("[Scheduled Fetch] Scheduled video fetch job completed at", new Date().toUTCString());
        return { statusCode: 200, body: "Scheduled task executed successfully." };

    } catch (error) {
        console.error("[Scheduled Fetch] CRITICAL Error in scheduled task main execution:", error.message, error.stack);
        // If the error is due to Firestore initialization, it would have been caught earlier by the top-level throw.
        // This catches errors from token refresh, API calls, or Firestore document access.
        return { statusCode: 500, body: `Scheduled task failed: ${error.message}` };
    }
};