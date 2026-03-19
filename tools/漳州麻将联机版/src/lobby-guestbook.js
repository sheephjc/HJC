import { ensureAnonymousAuth, getFirebaseServices, hasFirebaseConfig } from './firebase-client.js';
import {
    addDoc,
    collection,
    getDocs,
    getFirestore,
    limit,
    orderBy,
    query,
    setLogLevel,
    serverTimestamp
} from '../vendor/firebase/10.14.1/firebase-firestore.js';

const GUESTBOOK_COLLECTION = 'guestbook_lobby';
const GUESTBOOK_MAX_ROWS = 50;
const GUESTBOOK_REFRESH_MS = 15000;
const MAX_NAME_LEN = 24;
const MAX_TEXT_LEN = 180;
const FALLBACK_NAME = '游客';
let firestoreLogConfigured = false;

function cleanText(value, maxLen) {
    return String(value || '').trim().slice(0, maxLen);
}

function formatDate(value) {
    if (!value?.toDate) return '刚刚';
    try {
        return value.toDate().toLocaleString();
    } catch {
        return '刚刚';
    }
}

function buildMessageNode(data = {}) {
    const item = document.createElement('article');
    item.className = 'guestbook-item';

    const title = document.createElement('div');
    title.className = 'guestbook-item-title';
    title.textContent = `${String(data.name || FALLBACK_NAME)}:`;

    const text = document.createElement('div');
    text.className = 'guestbook-item-text';
    text.textContent = String(data.text || '');

    const time = document.createElement('time');
    time.className = 'guestbook-item-time';
    time.textContent = formatDate(data.createdAt);

    item.appendChild(title);
    item.appendChild(text);
    item.appendChild(time);
    return item;
}

export function initLobbyGuestbook() {
    const modalEl = document.getElementById('guestbook-modal');
    const openBtn = document.getElementById('guestbook-open-btn');
    const closeBtn = document.getElementById('guestbook-close-btn');
    const hintEl = document.getElementById('guestbook-hint');
    const listEl = document.getElementById('guestbook-list');
    const nameInput = document.getElementById('guestbook-name-input');
    const msgInput = document.getElementById('guestbook-message-input');
    const sendBtn = document.getElementById('guestbook-send-btn');
    const lobbyNicknameInput = document.getElementById('nickname-input');

    if (!modalEl || !openBtn || !closeBtn || !hintEl || !listEl || !nameInput || !msgInput || !sendBtn) {
        return () => {};
    }

    let firestoreCollectionRef = null;
    let initialized = false;
    let initPromise = null;
    let sending = false;
    let listQueryRef = null;
    let pollTimer = null;
    let lastLoadErrorAt = 0;

    const setHint = (text, isError = false) => {
        hintEl.textContent = text;
        hintEl.classList.toggle('error', !!isError);
    };

    const stopPolling = () => {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    };

    const loadMessages = async (showConnectedHint = false) => {
        if (!listQueryRef) return;
        try {
            const snapshot = await getDocs(listQueryRef);
            renderSnapshot(snapshot);
            if (showConnectedHint) {
                setHint('已连接，留言板可用。');
            }
        } catch (error) {
            const now = Date.now();
            if (now - lastLoadErrorAt > 20000) {
                console.warn('[guestbook] load failed:', error);
                lastLoadErrorAt = now;
            }
            setHint('连接不稳定，正在自动重试...', true);
        }
    };

    const startPolling = () => {
        if (pollTimer || !listQueryRef) return;
        pollTimer = setInterval(() => {
            loadMessages(false);
        }, GUESTBOOK_REFRESH_MS);
    };

    const renderSnapshot = (snapshot) => {
        listEl.innerHTML = '';
        if (!snapshot || snapshot.empty) {
            const empty = document.createElement('p');
            empty.className = 'guestbook-empty';
            empty.textContent = '暂无留言，来写第一条吧。';
            listEl.appendChild(empty);
            return;
        }

        snapshot.forEach((docSnap) => {
            const row = buildMessageNode(docSnap.data() || {});
            listEl.appendChild(row);
        });
    };

    const setSendBusy = (busy) => {
        sending = !!busy;
        sendBtn.disabled = busy || !initialized;
        sendBtn.textContent = busy ? '发送中...' : '发送';
    };

    const closeModal = () => {
        modalEl.classList.add('hidden');
        document.body.classList.remove('guestbook-open');
        stopPolling();
    };

    const openModal = () => {
        modalEl.classList.remove('hidden');
        document.body.classList.add('guestbook-open');
    };

    const ensureInitialized = async () => {
        if (initialized && firestoreCollectionRef) return true;
        if (initPromise) return initPromise;

        initPromise = (async () => {
            if (!hasFirebaseConfig()) {
                setHint('Firebase 配置缺失，留言板不可用。', true);
                sendBtn.disabled = true;
                return false;
            }

            try {
                if (!firestoreLogConfigured) {
                    setLogLevel('error');
                    firestoreLogConfigured = true;
                }
                await ensureAnonymousAuth();
                const { app } = getFirebaseServices();
                const firestore = getFirestore(app);
                firestoreCollectionRef = collection(firestore, GUESTBOOK_COLLECTION);

                listQueryRef = query(
                    firestoreCollectionRef,
                    orderBy('createdAt', 'desc'),
                    limit(GUESTBOOK_MAX_ROWS)
                );
                await loadMessages(true);

                initialized = true;
                sendBtn.disabled = false;
                return true;
            } catch (error) {
                console.error('[guestbook] init failed:', error);
                setHint(`初始化失败：${error?.message || '未知错误'}`, true);
                sendBtn.disabled = true;
                return false;
            } finally {
                initPromise = null;
            }
        })();

        return initPromise;
    };

    const handleSend = async () => {
        if (sending) return;
        const ready = await ensureInitialized();
        if (!ready || !firestoreCollectionRef) return;

        const fallbackName = cleanText(lobbyNicknameInput?.value || '', MAX_NAME_LEN);
        const name = cleanText(nameInput.value, MAX_NAME_LEN) || fallbackName || FALLBACK_NAME;
        const text = cleanText(msgInput.value, MAX_TEXT_LEN);

        if (!text) {
            setHint('请先输入留言内容。', true);
            return;
        }

        setSendBusy(true);
        try {
            await addDoc(firestoreCollectionRef, {
                name,
                text,
                source: 'lobby',
                createdAt: serverTimestamp()
            });
            msgInput.value = '';
            setHint('发送成功。');
            await loadMessages(false);
        } catch (error) {
            console.error('[guestbook] send failed:', error);
            setHint(`发送失败：${error?.message || '未知错误'}`, true);
        } finally {
            setSendBusy(false);
        }
    };

    const onModalOverlayClick = (event) => {
        if (event.target === modalEl) {
            closeModal();
        }
    };

    const onDocumentKeyDown = (event) => {
        if (event.key === 'Escape' && !modalEl.classList.contains('hidden')) {
            closeModal();
        }
    };

    const onMessageInputKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            handleSend();
        }
    };

    const onOpenClick = () => {
        openModal();
        ensureInitialized().then((ready) => {
            if (ready) startPolling();
        });
    };

    openBtn.addEventListener('click', onOpenClick);
    closeBtn.addEventListener('click', closeModal);
    modalEl.addEventListener('click', onModalOverlayClick);
    document.addEventListener('keydown', onDocumentKeyDown);
    msgInput.addEventListener('keydown', onMessageInputKeyDown);
    sendBtn.addEventListener('click', handleSend);

    setHint('点击右下角“留言板”打开。');
    sendBtn.disabled = true;

    return () => {
        openBtn.removeEventListener('click', onOpenClick);
        closeBtn.removeEventListener('click', closeModal);
        modalEl.removeEventListener('click', onModalOverlayClick);
        document.removeEventListener('keydown', onDocumentKeyDown);
        msgInput.removeEventListener('keydown', onMessageInputKeyDown);
        sendBtn.removeEventListener('click', handleSend);
        stopPolling();
    };
}
