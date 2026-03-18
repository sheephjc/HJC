import {
    initGame,
    nextRound,
    resetAll,
    openRuleModal,
    closeRuleModal,
    handleActionButton,
    setupActionAudioUnlock,
    getActionVoiceProfile,
    deselectAll
} from './engine/game-core.js';
import { initDebugTools } from './debug/debug-tools.js';

function bindUiEvents() {
    document.addEventListener('click', (event) => {
        const target = event.target;

        const gameActionBtn = target.closest('[data-game-action]');
        if (gameActionBtn) {
            event.stopPropagation();
            const action = gameActionBtn.dataset.gameAction;
            if (action === 'next-round') nextRound();
            if (action === 'reset-all') resetAll();
            return;
        }

        const openModalBtn = target.closest('[data-open-modal]');
        if (openModalBtn) {
            openRuleModal(openModalBtn.dataset.openModal);
            return;
        }

        const closeModalBtn = target.closest('[data-close-modal]');
        if (closeModalBtn) {
            closeRuleModal(closeModalBtn.dataset.closeModal);
            return;
        }

        const backdrop = target.closest('[data-modal-backdrop]');
        if (backdrop && target === backdrop) {
            closeRuleModal(backdrop.id);
            return;
        }

        const actionBtn = target.closest('#action-bar [data-action-type]');
        if (actionBtn) {
            handleActionButton(actionBtn.dataset.actionType, actionBtn.dataset.actionPayload);
            return;
        }

        if (target.closest('.rule-content')) return;

        deselectAll();
    });
}

function bootstrap() {
    bindUiEvents();
    initGame();
    setupActionAudioUnlock();
    setTimeout(() => getActionVoiceProfile(), 0);
    initDebugTools();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
    bootstrap();
}
