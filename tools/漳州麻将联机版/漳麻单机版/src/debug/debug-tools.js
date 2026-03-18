import {
    runHuTests,
    runRuleRegressionChecks,
    testHu,
    testQiangGang,
    startForcedGoldTestRound,
    youjinDebug,
    getStateSnapshot,
    getLegalActions
} from '../engine/game-core.js';

function installDebugGlobalsToWindow(target = window) {
    Object.defineProperty(target, 'danjin', {
        configurable: true,
        get() {
            startForcedGoldTestRound(1);
            return '[test] danjin 已执行';
        }
    });

    Object.defineProperty(target, 'shuangjin', {
        configurable: true,
        get() {
            startForcedGoldTestRound(2);
            return '[test] shuangjin 已执行';
        }
    });

    Object.defineProperty(target, 'sanjin', {
        configurable: true,
        get() {
            startForcedGoldTestRound(3);
            return '[test] sanjin 已执行';
        }
    });

    target.youjin_debug = youjinDebug;
    target.youjin_use_last_fn = () => target.youjin_debug(-1);
    Object.defineProperty(target, 'youjin_use_last', {
        configurable: true,
        get() {
            return target.youjin_use_last_fn();
        }
    });

    target.rule_regression = runRuleRegressionChecks;
}

export function initDebugTools() {
    installDebugGlobalsToWindow(window);
    window.zzmDebug = {
        runHuTests,
        runRuleRegressionChecks,
        testHu,
        testQiangGang,
        startForcedGoldTestRound,
        youjinDebug,
        getStateSnapshot,
        getLegalActions
    };
}
