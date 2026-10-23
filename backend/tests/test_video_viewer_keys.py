"""Video viewer keys: Space and K play or pause, they never close the viewer.

The preview dialog focuses its close button when it opens; Space on that button
used to close the viewer. Loads the real ``frontend/js/gallery/video-viewer.js``
in a Node vm realm with a fake DOM and sends key events to its document
listener: Space and K toggle playback (also after , and . frame steps), a
button the user reached with Tab still gets its Space, and nothing answers
while another dialog sits on top of the preview.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

VIEWER_JS = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "js"
    / "gallery"
    / "video-viewer.js"
)

SCRIPT = r"""
const vm = require('vm');
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));

class FakeElement {
  constructor(tag, id = '') { this.tag = tag; this.id = id; this.classList = { contains: () => true, add() {}, remove() {} }; }
  addEventListener() {}
  setAttribute() {}
  closest(selectors) {
    return selectors.split(',').some((s) => {
      s = s.trim();
      if (s.startsWith('#')) return s.slice(1) === this.id;
      return s.split(/[\[\s]/)[0] === this.tag;
    }) ? this : null;
  }
}
const video = Object.assign(new FakeElement('video', 'modal-video'), {
  paused: false, ended: false, currentTime: 1, duration: 3,
  play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
  removeAttribute() {}, load() {},
});
const elements = { 'modal-video': video, 'modal-video-stage': new FakeElement('div', 'modal-video-stage'), 'image-modal': new FakeElement('div', 'image-modal') };
const handlers = [];
let topModal = 'image-modal';
const ctx = {
  window: {}, console, localStorage: { getItem: () => null, setItem() {} },
  MutationObserver: class { observe() {} },
  Element: FakeElement,
  isTopModal: (id) => id === topModal,
  document: {
    readyState: 'complete',
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { if (type === 'keydown') handlers.push(fn); },
  },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(input.file, 'utf8'), ctx);
const viewer = ctx.window.VideoViewer;
viewer.imageId = 7;
const targets = { close: new FakeElement('button', 'modal-close'), body: new FakeElement('body'), video };
const out = [];
for (const step of input.steps) {
  if (step.top) { topModal = step.top; continue; }
  let prevented = false;
  const event = { key: step.key, target: targets[step.target || 'close'], ctrlKey: false, metaKey: false, altKey: false,
    preventDefault() { prevented = true; }, stopPropagation() {} };
  handlers.forEach((fn) => fn(event));
  out.push({ key: step.key, paused: video.paused, prevented });
}
process.stdout.write(JSON.stringify(out));
"""

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is not installed"
)


def press(steps: list) -> list:
    run = subprocess.run(
        ["node", "-e", SCRIPT],
        input=json.dumps({"file": str(VIEWER_JS), "steps": steps}),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(run.stdout)


def test_space_on_the_auto_focused_close_button_pauses_and_resumes():
    result = press([{"key": " "}, {"key": " "}])
    # prevented = the close button never gets the Space press.
    assert result == [
        {"key": " ", "paused": True, "prevented": True},
        {"key": " ", "paused": False, "prevented": True},
    ]


def test_space_and_k_resume_after_frame_steps():
    result = press(
        [{"key": "."}, {"key": ","}, {"key": " "}, {"key": "k"}, {"key": "K"}]
    )
    assert [step["paused"] for step in result] == [True, True, False, True, False]


def test_space_on_a_button_reached_with_tab_presses_that_button():
    result = press([{"key": "Tab"}, {"key": " "}, {"key": "k"}])
    assert result[1] == {"key": " ", "paused": False, "prevented": False}
    # K is not a button key: it still toggles.
    assert result[2]["paused"] is True


def test_space_on_the_player_itself_is_left_to_the_player():
    result = press([{"key": " ", "target": "video"}])
    assert result == [{"key": " ", "paused": False, "prevented": False}]


def test_keys_wait_while_another_dialog_is_on_top():
    result = press([{"top": "confirm-modal"}, {"key": " "}, {"key": "."}])
    assert result == [
        {"key": " ", "paused": False, "prevented": False},
        {"key": ".", "paused": False, "prevented": False},
    ]
