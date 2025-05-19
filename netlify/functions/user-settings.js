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
    // We only expect POST requests for this function for now
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405, // Method Not Allowed
            body: JSON.stringify({ error: 'Only POST requests are allowed.' }),
        };
    }

    try {
        const body = JSON.parse(event.body);
        const { action, payload } = body;

        if (action === 'saveChannelConfig') {
            // The payload should be the channelsConfig array
            const channelsConfig = payload;

            if (!Array.isArray(channelsConfig)) {
                return {
                    statusCode: 400, // Bad Request
                    body: JSON.stringify({ error: 'Invalid payload: channelsConfig must be an array.' }),
                };
            }

            // Get a reference to our specific settings document
            const docRef = firestore.collection(SETTINGS_COLLECTION).doc(CONFIG_DOCUMENT_ID);

            // Save the channelsConfig to Firestore.
            // The .set() method will create the document if it doesn't exist,
            // or overwrite it if it does. We want to store the channelsConfig
            // under a field named 'channels' within this document, just like we set up.
            // We use { merge: true } just in case there are other fields in the document
            // we don't want to accidentally wipe out, though for now, 'channels' is the only one.
            await docRef.set({
                channels: channelsConfig,
                lastUpdated: new Date().toISOString() // Add a timestamp for when it was last updated
            }, { merge: true });

            console.log(`[user-settings] Successfully saved channelsConfig to Firestore document: ${CONFIG_DOCUMENT_ID}`);
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, message: 'Channel configuration saved successfully.' }),
            };

        } else {
            return {
                statusCode: 400, // Bad Request
                body: JSON.stringify({ error: `Invalid action: ${action}` }),
            };
        }

    } catch (error) {
        console.error('[user-settings] Error processing request:', error.message, error.stack);
        // Check for JSON parsing errors specifically
        if (error instanceof SyntaxError && error.message.includes("JSON")) {
             return { statusCode: 400, body: JSON.stringify({ error: 'Bad request: Invalid JSON in request body.' }) };
        }
        return {
            statusCode: 500, // Internal Server Error
            body: JSON.stringify({ error: `An internal error occurred: ${error.message}` }),
        };
    }
};