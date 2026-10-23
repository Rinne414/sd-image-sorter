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
        quit: 'Quit',
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
        quit: '退出',
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
