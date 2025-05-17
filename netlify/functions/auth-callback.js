// netlify/functions/auth-callback.js
// This function runs after Google redirects the user back to our app.
// It takes the 'code' Google gives us and exchanges it for an 'access token' and 'refresh token'.

// IMPORTANT: Set these in your Netlify build environment variables, NOT here!
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET; // Your OAuth Client Secret
const REDIRECT_URI = process.env.REDIRECT_URI; // Must be the SAME as in auth-url.js

const fetch = require('node-fetch'); // Need to install this: npm install node-fetch

exports.handler = async (event, context) => {
    // Google sends an authorization 'code' in the URL query parameters.
    const code = event.queryStringParameters.code;

    if (!code) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing authorization code from Google." }),
        };
    }

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !REDIRECT_URI) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Server configuration error: Missing Google credentials or Redirect URI." }),
        };
    }

    try {
        // Now we exchange the 'code' for an 'access token' and 'refresh token'.
        // This request goes directly from our server to Google's server.
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                code: code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code', // We're using the authorization code grant type
            }),
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            console.error("Google token exchange error:", errorData);
            return {
                statusCode: tokenResponse.status,
                body: JSON.stringify({ error: "Failed to exchange code for token.", details: errorData }),
            };
        }

        const tokenData = await tokenResponse.json();
        // tokenData will contain: access_token, refresh_token, expires_in, scope, token_type

        // IMPORTANT: We need to send the access_token AND refresh_token back to the client (your browser app)
        // The client will then store these (e.g., in localStorage).
        // For enhanced security in a production app, you might store refresh_tokens server-side
        // and only issue short-lived access_tokens to the client. But for this project, client-side storage is simpler.

        // We will redirect the user back to the main page, with tokens in the URL hash.
        // The main page's JavaScript will then pick them up.
        // This is a common pattern for SPAs (Single Page Applications).
        // The frontend app's main page URL (e.g., where your index.html is served from)
        const FRONTEND_APP_URL = process.env.FRONTEND_APP_URL || '/'; // Set this to your main page URL

        const redirectUrlWithTokens = `${FRONTEND_APP_URL}#access_token=${tokenData.access_token}&refresh_token=${tokenData.refresh_token}&expires_in=${tokenData.expires_in}`;

        return {
            statusCode: 302, // HTTP 302 Found (Redirect)
            headers: {
                Location: redirectUrlWithTokens,
            },
            body: '', // Body is not needed for a redirect
        };

    } catch (error) {
        console.error("Error in auth-callback:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Internal server error during token exchange." }),
        };
    }
};