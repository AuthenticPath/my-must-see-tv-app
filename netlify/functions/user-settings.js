// netlify/functions/user-settings.js

// Import the Firestore library we just installed
const { Firestore } = require('@google-cloud/firestore');

// Initialize Firestore.
// This function will try to use the GOOGLE_SERVICE_ACCOUNT_CREDENTIALS
// environment variable if it's set (which it should be on Netlify).
// For local development, if this env var isn't set in your .env or shell,
// it might try to find default credentials if you've used `gcloud auth application-default login`.
// We'll ensure our Netlify setup is the primary way it authenticates.
// --- MODIFIED Firestore Initialization in user-settings.js ---
let firestore;
try {
    const projectId = process.env.GCP_PROJECT_ID;
    const clientEmail = process.env.GCP_CLIENT_EMAIL;
    // The private key from env var might have literal '\n' which need to be actual newlines.
    const privateKey = process.env.GCP_PRIVATE_KEY ? process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined;

    if (!projectId || !clientEmail || !privateKey) {
        console.warn("[user-settings] Missing one or more GCP credential environment variables (GCP_PROJECT_ID, GCP_CLIENT_EMAIL, GCP_PRIVATE_KEY). Firestore might not initialize correctly in deployed env.");
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
        console.log("[user-settings] Firestore initialized with split service account credentials.");
    }
} catch (error) {
    console.error("[user-settings] CRITICAL ERROR initializing Firestore:", error.message, error.stack);
    throw new Error("Firestore initialization failed. Check GCP credential environment variables.");
}

// --- END OF MODIFIED BLOCK ---

// The name of our collection in Firestore
const SETTINGS_COLLECTION = 'userAppSettings';
// The ID of the specific document within that collection where we store the main configuration
const CONFIG_DOCUMENT_ID = 'mainConfiguration';

exports.handler = async (event, context) => {
    // We now expect POST (for saving) and GET (for loading) requests
    // For simplicity, we'll just check for the action in the body for POST,
    // or a query param for GET if we were to implement it that way.
    // But since index.html will use POST for both for consistency, we'll stick to parsing POST body.

    let body;
    try {
        // All requests from our index.html will use POST with a JSON body
        if (event.httpMethod !== 'POST') {
             return { statusCode: 405, body: JSON.stringify({ error: 'Only POST requests are allowed for user settings.' }) };
        }
        body = JSON.parse(event.body);
    } catch (error) {
        console.error('[user-settings] Error parsing request body:', error.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON in request body.' }) };
    }

    const { action, payload } = body;

    try {
        if (action === 'saveChannelConfig') {
            const channelsConfig = payload; // The payload IS the channelsConfig array

            if (!Array.isArray(channelsConfig)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Invalid payload: channelsConfig must be an array.' }),
                };
            }

            const docRef = firestore.collection(SETTINGS_COLLECTION).doc(CONFIG_DOCUMENT_ID);
            await docRef.set({
                channels: channelsConfig,
                lastUpdated: new Date().toISOString()
            }, { merge: true });

            console.log(`[user-settings] Successfully saved channelsConfig to Firestore document: ${CONFIG_DOCUMENT_ID}`);
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, message: 'Channel configuration saved successfully.' }),
            };

        } else if (action === 'loadChannelConfig') { // --- NEW ACTION ---
            console.log(`[user-settings] Attempting to load channel configuration from Firestore: Document='${CONFIG_DOCUMENT_ID}'`);
            const docRef = firestore.collection(SETTINGS_COLLECTION).doc(CONFIG_DOCUMENT_ID);
            const docSnap = await docRef.get();

            if (!docSnap.exists) {
                console.log(`[user-settings] Document '${CONFIG_DOCUMENT_ID}' does not exist. Returning empty config.`);
                // It's okay if it doesn't exist yet (e.g., first time user), return an empty array.
                return {
                    statusCode: 200, // Successfully handled request, even if no data
                    body: JSON.stringify({ success: true, channelsConfig: [] }),
                };
            }

            const data = docSnap.data();
            // Ensure the 'channels' field exists and is an array, otherwise return empty
            const channelsConfig = (data && Array.isArray(data.channels)) ? data.channels : [];
            
            console.log(`[user-settings] Successfully loaded channelsConfig from Firestore. Found ${channelsConfig.length} channels.`);
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, channelsConfig: channelsConfig }),
            };

        } else {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: `Invalid action: ${action}` }),
            };
        }

    } catch (error) {
        console.error('[user-settings] Error processing request:', error.message, error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `An internal error occurred: ${error.message}` }),
        };
    }
};