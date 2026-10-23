'use strict';

/** Words the shell itself shows (tray, notices, start-up page). The web UI has its own. */

const STRINGS = {
    en: {
        tooltip: 'SD Image Sorter',
        open: 'Open SD Image Sorter',
        quickCollect: 'Quick collect',
        pauseWatching: 'Pause folder watching',
        resumeWatching: 'Resume folder watching',
        watchingUnknown: 'Folder watching: status not available',
        createShortcuts: 'Create desktop and Start menu shortcuts',
        quit: 'Quit',
        shortcutsTitle: 'Add shortcuts?',
        shortcutsAsk: 'Put SD Image Sorter on your desktop and in the Start menu? Moving this folder later breaks them; run this again from the tray to remake them.',
        shortcutsCreate: 'Create shortcuts',
        shortcutsLater: 'Not now',
        shortcutsNever: 'Do not ask again',
        shortcutsDone: 'Shortcuts created: {places}.',
        shortcutsPartial: 'Shortcuts created: {places}. Could not create: {failed}.',
        shortcutsFailed: 'Could not create the shortcuts ({failed}).',
        setupTitle: 'Setting up SD Image Sorter',
        setupDetail: 'First start: the program installs its core packages. A console window shows the progress; this needs an internet connection and takes a few minutes.',
        setupFailed: 'Setting up the core packages did not finish (exit code {code}). Check the internet connection, then try again; the console window showed the reason.',
        updating: 'Installing the update…',
        updatingDetail: 'SD Image Sorter restarts by itself when the update is installed.',
        updateStuck: 'The update did not finish within 15 minutes. The program is started again with the files it has; the update log is in update\\logs.',
        closeNoticeTitle: 'Still running in the tray',
        closeNotice: 'SD Image Sorter keeps watching your folders in the tray. Quit from the tray menu, or change this in Settings > Desktop.',
        starting: 'Starting SD Image Sorter…',
        startingDetail: 'The first start after an update can take a minute.',
        pythonMissing: 'Python for SD Image Sorter was not found in {root}. Run run.bat (or run-portable.bat / run.sh) once so it can set itself up, then start this again.',
        appRootMissing: 'The SD Image Sorter program folder (with backend\\main.py) was not found next to this program.',
        backendExited: 'The SD Image Sorter server stopped while starting (exit code {code}). The last lines of its log are below. Running run.bat once usually repairs a missing package.',
        backendTimeout: 'The SD Image Sorter server did not answer within 3 minutes. The last lines of its log are below.',
        noPort: 'Ports {first}-{last} are all used by other programs. Set SD_IMAGE_SORTER_PORT to a free port and start again.',
        retry: 'Try again',
        openLog: 'Open log folder',
    },
    'zh-CN': {
        tooltip: 'SD Image Sorter',
        open: '打开 SD Image Sorter',
        quickCollect: '快速收集',
        pauseWatching: '暂停监看文件夹',
        resumeWatching: '恢复监看文件夹',
        watchingUnknown: '监看文件夹：读不到状态',
        createShortcuts: '创建桌面和开始菜单快捷方式',
        quit: '退出',
        shortcutsTitle: '添加快捷方式？',
        shortcutsAsk: '把 SD Image Sorter 放到桌面和开始菜单？之后移动本文件夹会使它们失效；可以再从托盘菜单重新创建。',
        shortcutsCreate: '创建快捷方式',
        shortcutsLater: '以后再说',
        shortcutsNever: '不再询问',
        shortcutsDone: '已创建快捷方式：{places}。',
        shortcutsPartial: '已创建快捷方式：{places}。未能创建：{failed}。',
        shortcutsFailed: '无法创建快捷方式（{failed}）。',
        setupTitle: '正在设置 SD Image Sorter',
        setupDetail: '第一次启动：程序要安装核心组件。控制台窗口会显示进度；需要联网，要几分钟。',
        setupFailed: '核心组件没有装完（退出码 {code}）。请检查网络后重试；控制台窗口里有原因。',
        updating: '正在安装更新…',
        updatingDetail: '更新装好后，SD Image Sorter 会自动重新启动。',
        updateStuck: '更新在 15 分钟内没有完成。程序用现有文件重新启动；更新日志在 update\\logs。',
        closeNoticeTitle: '仍在托盘中运行',
        closeNotice: 'SD Image Sorter 在托盘里继续监看文件夹。要退出请用托盘菜单，或在 设置 > 桌面 中更改。',
        starting: '正在启动 SD Image Sorter…',
        startingDetail: '更新后的第一次启动可能要一分钟。',
        pythonMissing: '在 {root} 中找不到 SD Image Sorter 的 Python。请先运行一次 run.bat（或 run-portable.bat / run.sh）完成安装，然后再启动本程序。',
        appRootMissing: '在本程序旁边找不到 SD Image Sorter 的程序文件夹（含 backend\\main.py）。',
        backendExited: 'SD Image Sorter 服务在启动时停止了（退出码 {code}）。下面是日志的最后几行。运行一次 run.bat 通常能补好缺少的组件。',
        backendTimeout: 'SD Image Sorter 服务 3 分钟内没有响应。下面是日志的最后几行。',
        noPort: '端口 {first}-{last} 都被其他程序占用。请把 SD_IMAGE_SORTER_PORT 设为空闲端口后再启动。',
        retry: '重试',
        openLog: '打开日志文件夹',
    },
};

function pickLanguage(locale) {
    return String(locale || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function makeTranslator(locale) {
    const table = STRINGS[pickLanguage(locale)];
    return (key, params = {}) => {
        let text = table[key] || STRINGS.en[key] || key;
        for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
        return text;
    };
}

module.exports = { STRINGS, makeTranslator, pickLanguage };
