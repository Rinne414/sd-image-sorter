# Browser extension: store listing

Everything a store asks for, written once. The files to upload are made by
`python browser-extension/build.py <out dir>` (one zip for Chrome and Edge, one
for Firefox). The privacy policy is [BROWSER_EXTENSION_PRIVACY.md](BROWSER_EXTENSION_PRIVACY.md).

## Name

SD Image Sorter

## Short description (132 characters at most)

- English: Save pictures from any web page into SD Image Sorter on this computer, with the page they came from.
- 简体中文: 把网页上的图片连同来源页面，保存进本机的 SD Image Sorter。

## Category and language

- Chrome Web Store: Tools (or Workflow & Planning if Tools is not offered). Languages: English, Chinese (Simplified).
- Edge Add-ons: Productivity.
- Firefox: Photos, Music & Videos; Other.

## Description (English)

SD Image Sorter is a free program for Windows and Linux that manages AI-generated pictures on your own computer: it reads their prompts and settings, tags, sorts and searches them. This extension is its collecting hand in the browser.

What it does

- Right-click a picture on any page and choose "Save to SD Image Sorter".
- "Save pictures on this page..." shows every picture of the page; tick the ones you want and save them together.
- Drag a picture and a drop box appears; drop the picture on it to save.
- Each picture is saved as a file in the program's output folder (collected/date) and appears in its gallery at once, together with the address of the page it came from, so you can find the source again.

What you need

The program must be running on this computer. Get it at https://github.com/Rinne414/sd-image-sorter/releases . Then open the extension's options and press "Pair with the program"; the program asks in its own window whether to allow this browser. Until you allow it, nothing can be saved.

Privacy

The picture you save and the address of its page are handed to the program on this computer (127.0.0.1) and to nothing else. No account, no statistics, no advertising. The extension only accepts an address on this computer.

Open source: https://github.com/Rinne414/sd-image-sorter

## Description (简体中文)

SD Image Sorter 是一个免费的 Windows / Linux 程序，在你自己的电脑上管理 AI 生成的图片：读取提示词和参数、打标签、整理、搜索。这个扩展是它在浏览器里“收图”的那只手。

它能做什么

- 在任何网页上右键图片，选择“保存到 SD Image Sorter”。
- “保存本页图片…”会列出这一页的所有图片，勾选想要的，一次保存。
- 拖动图片时会出现一个投放框，把图片放上去就保存。
- 每张图片都会存成文件，放进程序的输出文件夹（collected/日期），并立刻出现在图库里，同时记下它来自哪个网页，方便以后找回出处。

需要什么

程序必须在这台电脑上运行。下载地址：https://github.com/Rinne414/sd-image-sorter/releases 。然后打开扩展的设置，按“与程序配对”；程序会在自己的窗口里问是否允许这个浏览器。在你允许之前，什么都不能保存。

隐私

你保存的图片和它所在网页的地址，只会交给这台电脑上的程序（127.0.0.1），不会交给其他任何地方。没有账号，没有统计，没有广告。扩展只接受本机地址。

开源：https://github.com/Rinne414/sd-image-sorter

## Single purpose (Chrome Web Store, Privacy tab)

Save pictures from web pages into the SD Image Sorter program running on the user's own computer.

## Permission justifications (Chrome Web Store and Edge)

- **Host permission (all sites)**: the user may save a picture from any page. The content script reads the picture the user chose from the page it is on, lists the page's pictures when the user opens "Save pictures on this page...", and shows the drop box. The background script fetches the chosen picture's file from the site that hosts it. `127.0.0.1` and `localhost` are where the program listens.
- **contextMenus**: the two right-click entries, "Save to SD Image Sorter" and "Save pictures on this page...".
- **storage**: the program's local address, the pairing token and one display setting, in local extension storage.
- **alarms**: once a minute the extension asks the local program whether it is running, to show that on the toolbar button.
- **declarativeNetRequestWithHostAccess**: some sites serve a picture only when the request carries the page as Referer. While it fetches a picture the user saved, the extension adds one session rule that sets Referer for that one request, and removes the rule afterwards. No request is blocked or redirected.
- **Remote code**: none. All code is in the package; nothing is downloaded or evaluated.

## Data usage (Chrome Web Store, Privacy tab)

- Collected: **Website content** (the picture the user saves) and **Web history** in the narrow sense of the address of the page that picture is on. Both are handed to the program on the user's own computer and nowhere else.
- Not collected: personally identifiable information, health, financial, authentication, personal communications, location, user activity.
- Certifications: data is not sold or transferred to third parties; it is not used for purposes unrelated to the single purpose; it is not used for creditworthiness or lending.
- Privacy policy URL: https://github.com/Rinne414/sd-image-sorter/blob/main/docs/BROWSER_EXTENSION_PRIVACY.md

## Firefox (addons.mozilla.org)

- The manifest declares `data_collection_permissions: required: websiteContent, browsingActivity` (the picture and its page address leave the browser for the local program) and needs Firefox 140 or later.
- Add-on id: `sd-image-sorter@rinne414.github.io`.
- Source code: the package is the source. No bundler, no minifier; `browser-extension/build.py` only copies `browser-extension/src` and writes the manifest.
- License: the repository's license.

## Notes for the reviewer

The extension talks to a program on the same computer, so it does nothing visible without it.

1. Download the Windows package (or a Linux package) from https://github.com/Rinne414/sd-image-sorter/releases/latest , extract it and start it (`run-portable.bat`, or `./run-portable.sh`). It serves `http://127.0.0.1:8487`.
2. Open the extension's options and press "Pair with the program". In the program's page, press Allow on the question that appears.
3. On any web page, right-click a picture and choose "Save to SD Image Sorter", or use "Save pictures on this page...".
4. The picture appears in the program's gallery; its file is in the program's `output/collected/<date>` folder.

No account is needed. Nothing leaves the computer.

## Screenshots (1280 x 800)

1. The options page, paired.
2. "Save pictures on this page...": the picker over a web page.
3. The picker after saving.
4. The saved pictures in the program's gallery.
