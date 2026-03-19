import { ensureAnonymousAuth, getFirebaseServices, hasFirebaseConfig } from './firebase-client.js';
import {
    addDoc,
    collection,
    getFirestore,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp
} from '../vendor/firebase/10.14.1/firebase-firestore.js';

const GUESTBOOK_COLLECTION = 'guestbook_lobby';
const GUESTBOOK_MAX_ROWS = 50;
const MAX_NAME_LEN = 24;
const MAX_TEXT_LEN = 180;
const FALLBACK_NAME = '游客';

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
    let unsubscribe = null;
    let initialized = false;
    let initPromise = null;
    let sending = false;

    const setHint = (text, isError = false) => {
        hintEl.textContent = text;
        hintEl.classList.toggle('error', !!isError);
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
                await ensureAnonymousAuth();
                const { app } = getFirebaseServices();
                const firestore = getFirestore(app);
                firestoreCollectionRef = collection(firestore, GUESTBOOK_COLLECTION);

                const listQuery = query(
                    firestoreCollectionRef,
                    orderBy('createdAt', 'desc'),
                    limit(GUESTBOOK_MAX_ROWS)
                );

                unsubscribe = onSnapshot(
                    listQuery,
                    (snapshot) => {
                        renderSnapshot(snapshot);
                        setHint('已连接，留言实时同步中。');
                    },
                    (error) => {
                        console.error('[guestbook] snapshot failed:', error);
                        setHint('加载留言失败，请稍后重试。', true);
                    }
                );

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
        ensureInitialized();
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
        if (typeof unsubscribe === 'function') {
            unsubscribe();
            unsubscribe = null;
        }
    };
}
