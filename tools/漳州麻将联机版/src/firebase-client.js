import { firebaseConfig } from './firebase-config.js';

const FIREBASE_SDK_VERSION = '10.14.1';
const FIREBASE_IMPORT_TIMEOUT_MS = 9000;
const FIREBASE_APP_NAME = 'zzm-online-main';
const FIREBASE_ERROR_CODE_SDK_LOAD = 'firebase-sdk-load-failed';
const FIREBASE_ERROR_CODE_DB_UNREACHABLE = 'firebase-db-unreachable';

const FIREBASE_LOCAL_SOURCE = Object.freeze({
    name: 'local-vendor',
    appUrl: `../vendor/firebase/${FIREBASE_SDK_VERSION}/firebase-app.js`,
    authUrl: `../vendor/firebase/${FIREBASE_SDK_VERSION}/firebase-auth.js`,
    dbUrl: `../vendor/firebase/${FIREBASE_SDK_VERSION}/firebase-database.js`
});

function inferProjectIdFromDatabaseURL(databaseURL = '') {
    const match = String(databaseURL).match(/^https:\/\/([a-z0-9-]+)-default-rtdb\./i);
    return match ? match[1] : '';
}

function normalizeConfig(config = {}) {
    const databaseURL = String(config.databaseURL || '').trim();
    const inferredProjectId = inferProjectIdFromDatabaseURL(databaseURL);
    const projectId = String(config.projectId || inferredProjectId || '').trim();
    const authDomain = String(config.authDomain || (projectId ? `${projectId}.firebaseapp.com` : '')).trim();

    return {
        ...config,
        databaseURL,
        projectId,
        authDomain
    };
}

function getMissingRequiredKeys(config = {}) {
    const normalized = normalizeConfig(config);
    const missing = [];
    if (!normalized.apiKey) missing.push('apiKey');
    if (!normalized.projectId) missing.push('projectId');
    if (!normalized.databaseURL) missing.push('databaseURL');
    return missing;
}

function isConfigReady(config) {
    return getMissingRequiredKeys(config).length === 0;
}

function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timeout (${ms}ms)`));
        }, ms);

        promise
            .then((value) => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch((error) => {
                clearTimeout(timer);
                reject(error);
            });
    });
}

function withErrorCode(error, code) {
    const wrapped = error instanceof Error ? error : new Error(String(error || 'unknown error'));
    wrapped.code = code;
    return wrapped;
}

function isLikelyNetworkError(error) {
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    return (
        code.includes('network')
        || code.includes('timeout')
        || code.includes('unavailable')
        || message.includes('network')
        || message.includes('fetch')
        || message.includes('unreachable')
        || message.includes('timeout')
        || message.includes('failed to fetch')
        || message.includes('connection')
        || message.includes('offline')
    );
}

function normalizeInitError(error) {
    if (String(error?.code || '') === FIREBASE_ERROR_CODE_SDK_LOAD) {
        return new Error(`Firebase init failed: SDK load failed | ${error?.message || error}`);
    }
    if (String(error?.code || '') === FIREBASE_ERROR_CODE_DB_UNREACHABLE || isLikelyNetworkError(error)) {
        return new Error(`Firebase init failed: database unreachable | ${error?.message || error}`);
    }
    return new Error(`Firebase init failed: ${error?.message || 'unknown error'}`);
}

function normalizeAuthError(error) {
    if (String(error?.code || '') === FIREBASE_ERROR_CODE_SDK_LOAD) {
        return new Error(`Firebase auth failed: SDK load failed | ${error?.message || error}`);
    }
    if (String(error?.code || '') === FIREBASE_ERROR_CODE_DB_UNREACHABLE || isLikelyNetworkError(error)) {
        return new Error(`Firebase auth failed: database unreachable | ${error?.message || error}`);
    }
    return new Error(`Firebase auth failed: ${error?.message || 'unknown error'}`);
}

function buildSdkApi(appMod, authMod, dbMod, sourceName) {
    return Object.freeze({
        initializeApp: appMod.initializeApp,
        getApps: appMod.getApps,
        initializeAuth: authMod.initializeAuth,
        browserLocalPersistence: authMod.browserLocalPersistence,
        browserSessionPersistence: authMod.browserSessionPersistence,
        inMemoryPersistence: authMod.inMemoryPersistence,
        getAuth: authMod.getAuth,
        onAuthStateChanged: authMod.onAuthStateChanged,
        signInAnonymously: authMod.signInAnonymously,
        getDatabase: dbMod.getDatabase,
        ref: dbMod.ref,
        get: dbMod.get,
        onValue: dbMod.onValue,
        push: dbMod.push,
        runTransaction: dbMod.runTransaction,
        set: dbMod.set,
        update: dbMod.update,
        onDisconnect: dbMod.onDisconnect,
        loadedFrom: sourceName
    });
}

async function loadSourceSdk(source) {
    const [appMod, authMod, dbMod] = await Promise.all([
        withTimeout(import(source.appUrl), FIREBASE_IMPORT_TIMEOUT_MS, `load firebase-app (${source.name})`),
        withTimeout(import(source.authUrl), FIREBASE_IMPORT_TIMEOUT_MS, `load firebase-auth (${source.name})`),
        withTimeout(import(source.dbUrl), FIREBASE_IMPORT_TIMEOUT_MS, `load firebase-database (${source.name})`)
    ]);

    return buildSdkApi(appMod, authMod, dbMod, source.name);
}

async function loadLocalVendorSdk(source = FIREBASE_LOCAL_SOURCE) {
    try {
        return await loadSourceSdk(source);
    } catch (error) {
        throw withErrorCode(
            new Error(`${source.name}: ${error?.message || error}`),
            FIREBASE_ERROR_CODE_SDK_LOAD
        );
    }
}

function initializeNamedApp(sdk, normalizedConfig) {
    const existing = sdk.getApps().find((item) => item?.name === FIREBASE_APP_NAME);
    return existing || sdk.initializeApp(normalizedConfig, FIREBASE_APP_NAME);
}

function initializeStableAuth(sdk, initializedApp) {
    if (typeof sdk.initializeAuth !== 'function') {
        return sdk.getAuth(initializedApp);
    }

    const preferredPersistence = sdk.browserLocalPersistence
        || sdk.browserSessionPersistence
        || sdk.inMemoryPersistence;

    try {
        if (preferredPersistence) {
            return sdk.initializeAuth(initializedApp, {
                persistence: preferredPersistence,
                popupRedirectResolver: undefined
            });
        }
    } catch {
        // ignore and fallback below
    }

    try {
        if (sdk.inMemoryPersistence) {
            return sdk.initializeAuth(initializedApp, {
                persistence: sdk.inMemoryPersistence,
                popupRedirectResolver: undefined
            });
        }
    } catch {
        // ignore and fallback below
    }

    return sdk.getAuth(initializedApp);
}

function buildStableRtdbApi(sdk) {
    return Object.freeze({
        ref: sdk.ref,
        get: sdk.get,
        onValue: sdk.onValue,
        push: sdk.push,
        runTransaction: sdk.runTransaction,
        set: sdk.set,
        update: sdk.update,
        onDisconnect: sdk.onDisconnect,
        onAuthStateChanged: sdk.onAuthStateChanged,
        signInAnonymously: sdk.signInAnonymously,
        loadedFrom: sdk.loadedFrom
    });
}

let app = null;
let auth = null;
let db = null;
let rtdbApi = null;
let initPromise = null;
let sourceLogPrinted = false;
let runtimeGuard = null;

function initRuntimeGuard(nextApp, nextDb, nextRtdbApi) {
    runtimeGuard = Object.freeze({
        appName: nextApp?.name || '',
        db: nextDb,
        rtdbApi: nextRtdbApi,
        sourceName: nextRtdbApi?.loadedFrom || ''
    });
}

function assertRuntimeGuard() {
    if (!runtimeGuard) return;
    if (!app || !auth || !db || !rtdbApi) {
        throw new Error('Firebase runtime guard failed: services are incomplete.');
    }

    const driftDetected = (
        runtimeGuard.db !== db
        || runtimeGuard.rtdbApi !== rtdbApi
        || runtimeGuard.appName !== app.name
        || runtimeGuard.sourceName !== rtdbApi.loadedFrom
    );

    if (driftDetected) {
        throw new Error('Firebase runtime instance drift detected. Please refresh and retry.');
    }
}

async function initFirebase() {
    if (app && auth && db && rtdbApi) {
        assertRuntimeGuard();
        return { app, auth, db };
    }

    if (initPromise) {
        return initPromise;
    }

    initPromise = (async () => {
        const normalizedConfig = normalizeConfig(firebaseConfig);
        const missingKeys = getMissingRequiredKeys(normalizedConfig);
        if (missingKeys.length > 0) {
            throw new Error(
                `Firebase config incomplete: missing ${missingKeys.join(', ')}. Fill src/firebase-config.js first.`
            );
        }

        const sdk = await loadLocalVendorSdk();
        const initializedApp = initializeNamedApp(sdk, normalizedConfig);
        const initializedAuth = initializeStableAuth(sdk, initializedApp);
        const initializedDb = sdk.getDatabase(initializedApp);
        const stableRtdbApi = buildStableRtdbApi(sdk);

        app = initializedApp;
        auth = initializedAuth;
        db = initializedDb;
        rtdbApi = stableRtdbApi;
        initRuntimeGuard(initializedApp, initializedDb, stableRtdbApi);

        if (!sourceLogPrinted && typeof console !== 'undefined' && typeof console.info === 'function') {
            console.info(`[firebase] sdk source: ${stableRtdbApi.loadedFrom} | app: ${initializedApp.name}`);
            sourceLogPrinted = true;
        }

        return { app, auth, db };
    })();

    try {
        return await initPromise;
    } catch (error) {
        initPromise = null;
        throw normalizeInitError(error);
    }
}

function waitForAuthUser(authInstance, onAuthStateChangedFn) {
    return new Promise((resolve) => {
        const off = onAuthStateChangedFn(authInstance, (user) => {
            off();
            resolve(user || null);
        });
    });
}

export function hasFirebaseConfig() {
    return isConfigReady(firebaseConfig);
}

export function getFirebaseServices() {
    if (!app || !auth || !db || !rtdbApi) {
        throw new Error('Firebase is not initialized. Complete login or check network connectivity.');
    }

    assertRuntimeGuard();
    return {
        app,
        auth,
        db,
        rtdb: rtdbApi,
        sourceName: rtdbApi.loadedFrom,
        appName: app.name
    };
}

export function getFirebaseConfigStatus() {
    const normalized = normalizeConfig(firebaseConfig);
    const missingKeys = getMissingRequiredKeys(normalized);
    return {
        config: normalized,
        missingKeys,
        ready: missingKeys.length === 0
    };
}

export async function ensureAnonymousAuth() {
    const { auth: authInstance } = await initFirebase();
    let user = authInstance.currentUser;
    if (!user) {
        try {
            await rtdbApi.signInAnonymously(authInstance);
            user = await waitForAuthUser(authInstance, rtdbApi.onAuthStateChanged);
        } catch (error) {
            throw normalizeAuthError(
                isLikelyNetworkError(error)
                    ? withErrorCode(error, FIREBASE_ERROR_CODE_DB_UNREACHABLE)
                    : error
            );
        }
    }
    if (!user) {
        throw new Error('Anonymous login failed: uid unavailable.');
    }
    return user;
}
