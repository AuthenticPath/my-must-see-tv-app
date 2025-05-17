{\rtf1\ansi\ansicpg1252\cocoartf2639
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww33400\viewh17700\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 // netlify/functions/youtube-api.js\
// This function will talk to the YouTube API to search for videos and update playlists.\
// It will require the user's access_token to act on their behalf.\
\
// IMPORTANT: Set your YouTube Data API Key in Netlify environment variables\
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY; // Your regular YouTube Data API Key\
const fetch = require('node-fetch');\
\
// Helper to make authenticated calls to YouTube API\
async function callYouTubeApi(endpoint, accessToken, method = 'GET', body = null) \{\
    const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';\
    const headers = \{\
        'Authorization': `Bearer $\{accessToken\}`, // User's access token\
        'Accept': 'application/json',\
    \};\
    if (method === 'POST' || method === 'PUT') \{\
        headers['Content-Type'] = 'application/json';\
    \}\
\
    const options = \{ method, headers \};\
    if (body) \{\
        options.body = JSON.stringify(body);\
    \}\
\
    const response = await fetch(`$\{YOUTUBE_API_BASE\}$\{endpoint\}`, options);\
    if (!response.ok) \{\
        const errorData = await response.json();\
        console.error("YouTube API Error:", errorData.error.message, "Status:", response.status);\
        throw new Error(`YouTube API request failed: $\{errorData.error.message\} (Status: $\{response.status\})`);\
    \}\
    return response.json();\
\}\
\
\
exports.handler = async (event, context) => \{\
    if (!YOUTUBE_API_KEY) \{\
        return \{ statusCode: 500, body: JSON.stringify(\{ error: "Server configuration error: Missing YouTube API Key." \}) \};\
    \}\
\
    // The client (your browser app) MUST send its access_token in the request header or body.\
    // We'll expect it in an 'Authorization' header like 'Bearer YOUR_ACCESS_TOKEN'.\
    const authHeader = event.headers.authorization;\
    if (!authHeader || !authHeader.startsWith('Bearer ')) \{\
        return \{ statusCode: 401, body: JSON.stringify(\{ error: "Missing or invalid access token." \}) \};\
    \}\
    const accessToken = authHeader.split(' ')[1];\
\
    // The client will tell us what action to perform and provide necessary data.\
    const \{ action, payload \} = JSON.parse(event.body);\
\
    try \{\
        if (action === 'findOrCreatePlaylist') \{\
            const \{ playlistName \} = payload;\
            // 1. List user's playlists\
            let playlistsData = await callYouTubeApi(`/playlists?part=snippet&mine=true&maxResults=50`, accessToken);\
            let existingPlaylist = playlistsData.items.find(p => p.snippet.title === playlistName);\
\
            if (existingPlaylist) \{\
                return \{ statusCode: 200, body: JSON.stringify(\{ playlistId: existingPlaylist.id \}) \};\
            \} else \{\
                // 2. Create playlist if not found\
                const newPlaylistData = await callYouTubeApi(`/playlists?part=snippet,status`, accessToken, 'POST', \{\
                    snippet: \{ title: playlistName, description: "My daily dose of must-see TV!" \},\
                    status: \{ privacyStatus: "private" \} // or "public" or "unlisted"\
                \});\
                return \{ statusCode: 200, body: JSON.stringify(\{ playlistId: newPlaylistData.id \}) \};\
            \}\
        \}\
        else if (action === 'fetchChannelVideos') \{\
            const \{ channelId, keywords, publishedAfter \} = payload;\
            // Using search endpoint is more flexible for keywords and recency for a specific channel.\
            // Note: To get only "new" videos, we'd typically use 'publishedAfter'.\
            // We'll sort by date and take the most recent ones.\
            // The API key is used here because we are searching public data, not user-specific data.\
            let searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=$\{channelId\}&order=date&type=video&maxResults=10&key=$\{YOUTUBE_API_KEY\}`; // Fetch 10 most recent\
            if (publishedAfter) \{\
                 searchUrl += `&publishedAfter=$\{publishedAfter\}`; // e.g., 2023-01-01T00:00:00Z\
            \}\
\
            const response = await fetch(searchUrl);\
            if (!response.ok) \{\
                const errorData = await response.json();\
                throw new Error(`YouTube Search API error: $\{errorData.error.message\}`);\
            \}\
            const videoData = await response.json();\
\
            let videos = videoData.items.map(item => (\{\
                id: item.id.videoId,\
                title: item.snippet.title,\
                publishedAt: item.snippet.publishedAt,\
                thumbnail: item.snippet.thumbnails.default.url\
            \}));\
\
            // Filter by keywords if provided\
            if (keywords && keywords.trim() !== "") \{\
                const keywordArray = keywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k);\
                videos = videos.filter(video =>\
                    keywordArray.some(keyword => video.title.toLowerCase().includes(keyword))\
                );\
            \}\
            return \{ statusCode: 200, body: JSON.stringify(\{ videos \}) \};\
        \}\
        else if (action === 'addVideoToPlaylist') \{\
            const \{ playlistId, videoId \} = payload;\
            const result = await callYouTubeApi(`/playlistItems?part=snippet`, accessToken, 'POST', \{\
                snippet: \{\
                    playlistId: playlistId,\
                    position: 0, // Add to the top of the playlist\
                    resourceId: \{\
                        kind: "youtube#video",\
                        videoId: videoId\
                    \}\
                \}\
            \});\
            return \{ statusCode: 200, body: JSON.stringify(\{ success: true, videoIdAdded: videoId, item: result \}) \};\
        \}\
        // Optional: Action to get existing playlist items (to avoid duplicates or for cleanup)\
        else if (action === 'getPlaylistItems') \{\
            const \{ playlistId \} = payload;\
            let allItems = [];\
            let nextPageToken = null;\
            do \{\
                const playlistItemsData = await callYouTubeApi(`/playlistItems?part=snippet&playlistId=$\{playlistId\}&maxResults=50$\{nextPageToken ? '&pageToken='+nextPageToken : ''\}`, accessToken);\
                allItems = allItems.concat(playlistItemsData.items.map(item => item.snippet.resourceId.videoId));\
                nextPageToken = playlistItemsData.nextPageToken;\
            \} while (nextPageToken);\
            return \{ statusCode: 200, body: JSON.stringify(\{ videoIds: allItems \}) \};\
        \}\
        else \{\
            return \{ statusCode: 400, body: JSON.stringify(\{ error: "Invalid action." \}) \};\
        \}\
\
    \} catch (error) \{\
        console.error("Error in youtube-api function:", error.message);\
        return \{ statusCode: 500, body: JSON.stringify(\{ error: error.message || "An internal server error occurred." \}) \};\
    \}\
\};}