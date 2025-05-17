// netlify/functions/auth-url.js
// This function will generate the special URL you need to click to log in with Google/YouTube.

// IMPORTANT: Set these in your Netlify build environment variables, NOT here!
// GOOGLE_CLIENT_ID (your OAuth Client ID from Google Cloud Console)
// For local dev, you can use a .env file and 'netlify-lambda' or 'netlify dev'
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// This is where Google will send the user back AFTER they log in.
// It MUST match one of the "Authorized redirect URIs" you set in Google Cloud Console.
// Make sure this points to your *auth-callback* serverless function.
const REDIRECT_URI = process.env.REDIRECT_URI; // e.g., https://your-site.netlify.app/.netlify/functions/auth-callback
                                                // or for local: http://localhost:8888/.netlify/functions/auth-callback

exports.handler = async (event, context) => {
    // Log the environment variables to the netlify dev console
    console.log("[auth-url] GOOGLE_CLIENT_ID:", GOOGLE_CLIENT_ID);
    console.log("[auth-url] REDIRECT_URI:", REDIRECT_URI);

    if (!GOOGLE_CLIENT_ID || !REDIRECT_URI) {
	console.error("[auth-url] Server configuration error: Missing Google Client ID or Redirect URI from environment variables.");
        return {
            statusCode: 500,
	    // Send back a JSON error object so the client doesn't break on response.json()
            body: JSON.stringify({ error: "Server configuration error: Missing Google Client ID or Redirect URI." }),
        };
    }

    const scopes = [
        'https://www.googleapis.com/auth/youtube.readonly', // To read video info
        'https://www.googleapis.com/auth/youtube.force-ssl'  // To add/remove videos from playlists
    ].join(' '); // Scopes need to be a space-separated string.

    // This is the special URL we're building.
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `scope=${encodeURIComponent(scopes)}&` +
        `access_type=offline&` + // 'offline' means we can get a refresh_token to get new access_tokens later
        `include_granted_scopes=true&` +
        `response_type=code&` + // We want an authorization 'code' first
        `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
        `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}`;

    console.log("[auth-url] Successfully generated authUrl:", authUrl);
    return {
        statusCode: 200,
        body: JSON.stringify({ authUrl: authUrl }),
    };
};