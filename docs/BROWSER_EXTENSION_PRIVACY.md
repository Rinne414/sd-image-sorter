# SD Image Sorter browser extension: privacy policy

Last changed: 2026-11-12

This extension has one purpose: saving pictures from web pages into SD Image Sorter, a program that runs on your own computer.

## What the extension handles

- **The picture you save.** When you right-click a picture and choose "Save to SD Image Sorter", drop a picture on the drop box, or pick pictures with "Save pictures on this page...", the extension reads that picture from the page.
- **The address of the page it came from**, and the picture's own address, so the program can show where a picture was collected.
- **Its own settings**, kept in the browser's local extension storage: the address of the program on this computer, a pairing token the extension made up itself, and whether the drop box is shown.

Nothing is read from a page until you save a picture from it or start dragging one (the drop box then appears). To list the pictures of a page for "Save pictures on this page...", the extension looks at that page's picture elements when you ask.

## Where it goes

Only to SD Image Sorter on this computer, at the address shown in the extension's options (`http://127.0.0.1:8487` unless you changed it). The options only accept an address on this computer (`127.0.0.1` or `localhost`).

- What you save is sent to no other server. To get a picture's file, the extension asks the web site that shows it, the same request the browser itself makes for that picture.
- It has no statistics, no analytics, no advertising and no account.
- Nothing is sold or shared with anyone.
- The author of the extension receives nothing.

The program stores the saved pictures in its output folder on your disk (`collected/<date>`), together with the page address. What the program itself does is described in the "What goes online" table of the [README](../README.md).

## Why it asks for these permissions

- **Access to all web sites**: a picture can be on any page, and the extension has to read the picture you chose from the page it is on. It also needs to reach the program at `127.0.0.1` / `localhost`.
- **Context menus**: the "Save to SD Image Sorter" entries in the right-click menu.
- **Storage**: the settings listed above.
- **Alarms**: a check once a minute of whether the program is running, shown on the toolbar button.
- **declarativeNetRequest**: some sites only hand out a picture when the request names the page it is on. While the extension fetches a picture you saved, it sets that one header (Referer) for that one request, then removes the rule.

## Pairing

Before anything can be saved, the program asks in its own window whether to allow this browser's extension. You can remove the pairing in the extension's options ("Forget this pairing") or in the program's Settings.

## Removing your data

Uninstalling the extension removes its settings. The pictures you saved are ordinary files in the program's output folder; delete them there.

## Contact

Questions and problems: <https://github.com/Rinne414/sd-image-sorter/issues>

---

# SD Image Sorter 浏览器扩展：隐私政策

最后修改：2026-11-12

这个扩展只做一件事：把网页上的图片保存进运行在你自己电脑上的 SD Image Sorter。

## 扩展会处理什么

- **你保存的图片。** 右键图片选择“保存到 SD Image Sorter”、把图片拖到投放框、或用“保存本页图片…”挑选图片时，扩展会从网页读取这张图片。
- **图片所在网页的地址**，以及图片本身的地址，这样程序能显示图片是从哪里收集的。
- **扩展自己的设置**，保存在浏览器的本地扩展存储里：本机程序的地址、扩展自己生成的配对令牌、是否显示投放框。

在你保存图片或开始拖动图片（这时会出现投放框）之前，扩展不会读取网页上的任何内容。使用“保存本页图片…”时，扩展会在你要求时查看这个页面里的图片元素，用来列出可选的图片。

## 数据去哪里

只交给本机上的 SD Image Sorter，地址就是扩展设置里显示的那个（没改过的话是 `http://127.0.0.1:8487`）。设置里只接受本机地址（`127.0.0.1` 或 `localhost`）。

- 你保存的内容不会发给任何其他服务器。为了拿到图片文件，扩展会向显示这张图的网站请求它，和浏览器自己取这张图时发的请求一样。
- 没有统计、没有分析、没有广告、没有账号。
- 不出售，也不与任何人分享。
- 扩展的作者收不到任何数据。

程序会把保存的图片连同网页地址放在你硬盘上的输出文件夹里（`collected/<日期>`）。程序本身会联网做什么，见 [README](../README.md) 里的“什么会联网”表格。

## 为什么需要这些权限

- **访问所有网站**：图片可能在任何网页上，扩展要从图片所在的页面读取你选的那张图；还要能访问 `127.0.0.1` / `localhost` 上的程序。
- **右键菜单**：右键菜单里的“保存到 SD Image Sorter”。
- **存储**：上面列出的设置。
- **定时器**：每分钟检查一次程序是否在运行，显示在工具栏按钮上。
- **declarativeNetRequest**：有些网站只有在请求写明来源页面时才给图片。扩展在取你保存的那张图时，只为那一次请求设置这一个请求头（Referer），之后就把规则删掉。

## 配对

在能保存任何东西之前，程序会在自己的窗口里询问是否允许这个浏览器的扩展。你可以在扩展的设置里（“忘记这次配对”）或程序的设置里取消配对。

## 删除你的数据

卸载扩展就会删除它的设置。你保存的图片是程序输出文件夹里的普通文件，在那里删除即可。

## 联系

问题与反馈：<https://github.com/Rinne414/sd-image-sorter/issues>
