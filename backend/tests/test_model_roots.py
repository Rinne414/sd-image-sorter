"""SEC1b / SEC1c: where model weights may come from.

Files that need a full pickle (a YOLO .pt, a generic torch .pth) are loaded
only from the program's own models folders (PROJECT_ROOT/models,
DATA_DIR/models) or a folder the user added as a trusted model folder in
Model Center (a ComfyUI install, a NAS). A network path is refused before
any filesystem access unless it lies inside a trusted folder. The official
(non-local) artist sources never carry a path at all.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

import model_roots


@pytest.fixture
def roots(tmp_path, monkeypatch):
    """Program folders and the settings file, all under tmp_path."""
    import config

    project = tmp_path / "project"
    data = tmp_path / "data"
    config_dir = data / "config"
    (project / "models").mkdir(parents=True)
    (data / "models").mkdir(parents=True)
    config_dir.mkdir(parents=True)
    monkeypatch.setattr(config, "PROJECT_ROOT", project)
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(
        config, "APP_SETTINGS_CONFIG_PATH", config_dir / "app-settings.json"
    )
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    return SimpleNamespace(
        project_models=project / "models",
        data_models=data / "models",
        settings=config_dir / "app-settings.json",
        elsewhere=elsewhere,
    )


def _record_path_access(monkeypatch, module):
    """Every resolve/is_file/is_dir/exists/stat on `module.Path` lands in the
    returned list (pydantic turns an AssertionError into a 400, so a
    raising guard alone proves nothing)."""
    touched = []

    class _RecordingPath(Path):
        def _touched(self, *_args, **_kwargs):
            touched.append(str(self))
            raise RuntimeError("must not touch the filesystem")

        resolve = is_file = is_dir = exists = stat = _touched

    monkeypatch.setattr(module, "Path", _RecordingPath)
    return touched


NAS = r"\\nas\share\models"


class TestTrustedFolderStore:
    def test_empty_by_default(self, roots):
        assert model_roots.list_trusted_model_folders() == []

    def test_add_local_folder_persists_and_dedupes(self, roots):
        comfy = roots.elsewhere / "ComfyUI" / "models"
        comfy.mkdir(parents=True)
        stored = model_roots.add_trusted_model_folder(str(comfy))
        assert stored == [str(comfy.resolve())]
        assert model_roots.add_trusted_model_folder(str(comfy) + "/") == stored
        assert (
            json.loads(roots.settings.read_text(encoding="utf-8"))[
                "trusted_model_folders"
            ]
            == stored
        )
        assert model_roots.list_trusted_model_folders() == stored

    def test_a_missing_local_folder_or_a_file_is_refused(self, roots):
        with pytest.raises(ValueError):
            model_roots.add_trusted_model_folder(str(roots.elsewhere / "nope"))
        weights = roots.elsewhere / "weights.pt"
        weights.write_bytes(b"w")
        with pytest.raises(ValueError):
            model_roots.add_trusted_model_folder(str(weights))
        with pytest.raises(ValueError):
            model_roots.add_trusted_model_folder("   ")
        assert model_roots.list_trusted_model_folders() == []

    def test_a_network_folder_is_accepted_without_touching_it(self, roots, monkeypatch):
        """The user typed it in Model Center; a NAS may be offline right now."""
        touched = _record_path_access(monkeypatch, model_roots)
        stored = model_roots.add_trusted_model_folder(NAS + "\\")
        assert stored == [NAS]
        assert touched == []

    def test_remove(self, roots):
        comfy = roots.elsewhere / "comfy"
        comfy.mkdir()
        model_roots.add_trusted_model_folder(str(comfy))
        model_roots.add_trusted_model_folder(NAS)
        assert model_roots.remove_trusted_model_folder(str(comfy)) == [NAS]
        assert model_roots.remove_trusted_model_folder(NAS.upper()) == []
        with pytest.raises(KeyError):
            model_roots.remove_trusted_model_folder(str(comfy))


class TestTrustedFolderApi:
    def test_list_add_remove(self, test_client, roots):
        comfy = roots.elsewhere / "ComfyUI" / "models"
        comfy.mkdir(parents=True)
        listing = test_client.get("/api/models/trusted-folders")
        assert listing.status_code == 200, listing.text
        body = listing.json()
        assert body["folders"] == []
        # the two program models folders first, then the configured *_MODEL_DIR values
        assert {Path(p).name for p in body["program_folders"][:2]} == {"models"}
        assert len(body["program_folders"]) > 2

        added = test_client.post(
            "/api/models/trusted-folders", json={"path": str(comfy)}
        )
        assert added.status_code == 200, added.text
        folders = added.json()["folders"]
        assert folders == [
            {"path": str(comfy.resolve()), "kind": "local", "exists": True}
        ]

        nas = test_client.post("/api/models/trusted-folders", json={"path": NAS})
        assert nas.status_code == 200, nas.text
        assert nas.json()["folders"][1]["kind"] == "network"

        removed = test_client.request(
            "DELETE", "/api/models/trusted-folders", json={"path": str(comfy)}
        )
        assert removed.status_code == 200, removed.text
        assert [f["path"] for f in removed.json()["folders"]] == [NAS]

    def test_invalid_add_is_400_and_unknown_remove_is_404(self, test_client, roots):
        missing = test_client.post(
            "/api/models/trusted-folders", json={"path": str(roots.elsewhere / "nope")}
        )
        assert missing.status_code == 400, missing.text
        unknown = test_client.request(
            "DELETE", "/api/models/trusted-folders", json={"path": str(roots.elsewhere)}
        )
        assert unknown.status_code == 404, unknown.text


class TestAllowedRoots:
    def test_program_folders_and_trusted_folders(self, roots):
        inside_project = roots.project_models / "yolo" / "a.pt"
        inside_data = roots.data_models / "artist" / "b.pth"
        outside = roots.elsewhere / "c.pt"
        for file in (inside_project, inside_data, outside):
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"w")
        assert model_roots.is_under_allowed_model_root(str(inside_project))
        assert model_roots.is_under_allowed_model_root(str(inside_data))
        assert not model_roots.is_under_allowed_model_root(str(outside))
        model_roots.add_trusted_model_folder(str(roots.elsewhere))
        assert model_roots.is_under_allowed_model_root(str(outside))

    def test_a_sibling_whose_name_starts_with_the_root_is_outside(self, roots):
        """`<root>/models2/x.pt` is not under `<root>/models`: path semantics,
        not a string prefix."""
        sibling = roots.project_models.parent / "models2" / "x.pt"
        sibling.parent.mkdir(parents=True)
        sibling.write_bytes(b"w")
        assert not model_roots.is_under_allowed_model_root(str(sibling))


class TestNetworkPathRejection:
    @pytest.mark.parametrize(
        "raw", [r"\\nas\share\x.pt", "//nas/share/x.pt", r"\\attacker\s\evil.pth"]
    )
    def test_an_untrusted_network_path_is_refused_before_any_filesystem_access(
        self, roots, monkeypatch, raw
    ):
        touched = _record_path_access(monkeypatch, model_roots)
        assert model_roots.network_path_rejection(raw)
        assert touched == []

    def test_a_network_path_inside_a_trusted_folder_passes(self, roots, monkeypatch):
        model_roots.add_trusted_model_folder(NAS)
        touched = _record_path_access(monkeypatch, model_roots)
        assert model_roots.network_path_rejection(NAS + r"\yolo\seg.pt") is None
        assert model_roots.network_path_rejection(r"\\NAS\Share\MODELS\seg.pt") is None
        assert model_roots.network_path_rejection(r"\\nas\share\models2\seg.pt")
        assert model_roots.network_path_rejection(r"\\nas\other\models\seg.pt")
        assert touched == []

    def test_local_paths_are_never_network(self, roots):
        assert model_roots.network_path_rejection(r"C:\models\x.pt") is None
        assert model_roots.network_path_rejection("/home/u/models/x.pt") is None


def _fake_torch(monkeypatch):
    """torch.load that refuses the safe mode (pickled classes) and records
    every weights_only it was asked for."""
    calls = []

    def load(path, map_location="cpu", weights_only=None, **_kwargs):
        calls.append(weights_only)
        if weights_only:
            raise RuntimeError("Weights only load failed")
        return SimpleNamespace(eval=lambda: None)

    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(load=load))
    return calls


class TestArtistGenericCheckpoint:
    """SEC1b: the unsafe full unpickle only inside an allowed root."""

    def _identifier(self):
        from artist_identifier import ArtistIdentifier

        return ArtistIdentifier()

    def test_outside_the_allowed_roots_never_falls_back(self, roots, monkeypatch):
        calls = _fake_torch(monkeypatch)
        weights = roots.elsewhere / "someone.pth"
        weights.write_bytes(b"w")
        with pytest.raises(RuntimeError) as exc:
            self._identifier()._load_generic_torch_checkpoint(str(weights))
        assert calls == [True]
        message = str(exc.value)
        assert (
            "trusted" in message
            and "class_mapping.csv" in message
            and ".onnx" in message
        )
        assert "信任" in message

    def test_inside_the_program_models_folder_falls_back(self, roots, monkeypatch):
        calls = _fake_torch(monkeypatch)
        weights = roots.data_models / "artist" / "mine.pth"
        weights.parent.mkdir(parents=True)
        weights.write_bytes(b"w")
        identifier = self._identifier()
        identifier._load_generic_torch_checkpoint(str(weights))
        assert calls == [True, False]
        assert identifier._backend == "torch-generic"

    def test_inside_a_trusted_folder_falls_back(self, roots, monkeypatch):
        calls = _fake_torch(monkeypatch)
        comfy = roots.elsewhere / "ComfyUI" / "models" / "lsnet"
        comfy.mkdir(parents=True)
        weights = comfy / "mine.pth"
        weights.write_bytes(b"w")
        model_roots.add_trusted_model_folder(
            str(roots.elsewhere / "ComfyUI" / "models")
        )
        self._identifier()._load_generic_torch_checkpoint(str(weights))
        assert calls == [True, False]


class TestCensorModelPaths:
    """SEC1b: the legacy YOLO path for detect and media censoring."""

    def _resolve(self, raw):
        from services.censor_service import CensorService

        return CensorService._resolve_legacy_model_path(raw)

    def test_a_trusted_folder_is_accepted(self, roots):
        comfy = roots.elsewhere / "ComfyUI" / "models" / "ultralytics"
        comfy.mkdir(parents=True)
        weights = comfy / "seg.onnx"
        weights.write_bytes(b"w")
        model_roots.add_trusted_model_folder(
            str(roots.elsewhere / "ComfyUI" / "models")
        )
        assert self._resolve(str(weights)) == str(weights.resolve())

    def test_outside_the_allowed_roots_is_400(self, roots):
        weights = roots.elsewhere / "seg.onnx"
        weights.write_bytes(b"w")
        with pytest.raises(HTTPException) as exc:
            self._resolve(str(weights))
        assert exc.value.status_code == 400
        assert "trusted" in str(exc.value.detail)

    def test_an_untrusted_network_path_is_400_before_any_filesystem_access(
        self, roots, monkeypatch
    ):
        from utils import path_validation

        touched = _record_path_access(monkeypatch, model_roots)
        touched_validation = _record_path_access(monkeypatch, path_validation)
        with pytest.raises(HTTPException) as exc:
            self._resolve(r"\\attacker\s\evil.pt")
        assert exc.value.status_code == 400
        assert touched == [] and touched_validation == []

    def test_media_start_refuses_a_model_path_outside_the_allowed_roots(
        self, test_client, roots
    ):
        weights = roots.elsewhere / "seg.pt"
        weights.write_bytes(b"w")
        response = test_client.post(
            "/api/censor/media/start",
            json={
                "folder": str(roots.elsewhere),
                "model_type": "legacy",
                "model_path": str(weights),
            },
        )
        assert response.status_code == 400, response.text
        assert "trusted" in response.text

    def test_the_yolo_metadata_probe_opens_pt_only_inside_the_allowed_roots(
        self, roots, monkeypatch
    ):
        import model_health_paths

        opened = []

        class _FakeYolo:
            def __init__(self, path):
                opened.append(path)
                self.names = {0: "pussy"}

        monkeypatch.setitem(
            sys.modules, "ultralytics", types.SimpleNamespace(YOLO=_FakeYolo)
        )
        monkeypatch.setattr(
            model_health_paths._svc(), "_module_installed", lambda _name: True
        )
        outside = roots.elsewhere / "seg.pt"
        outside.write_bytes(b"w")
        inside = roots.data_models / "yolo" / "seg.pt"
        inside.parent.mkdir(parents=True)
        inside.write_bytes(b"w")
        assert model_health_paths._load_yolo_class_names(outside) == []
        assert opened == []
        assert model_health_paths._load_yolo_class_names(inside) == ["pussy"]
        assert opened == [str(inside)]


class TestArtistModelConfig:
    """SEC1c: the Style Finder's model settings."""

    def test_a_non_local_source_carries_no_path(self):
        from routers.artists import ArtistModelConfig

        for source in ("huggingface", "modelscope"):
            config = ArtistModelConfig(
                model_source=source, model_path="C:/anything/evil.txt"
            )
            assert config.model_path is None

    def test_a_local_untrusted_network_path_is_refused_before_any_filesystem_access(
        self, roots, monkeypatch
    ):
        from pydantic import ValidationError as PydanticValidationError
        from routers import artists as artists_router
        from routers.artists import ArtistModelConfig

        touched = _record_path_access(monkeypatch, artists_router)
        touched_roots = _record_path_access(monkeypatch, model_roots)
        with pytest.raises(PydanticValidationError) as exc:
            ArtistModelConfig(model_source="local", model_path=r"\\attacker\s\evil.pth")
        assert "trusted" in str(exc.value)
        assert touched == [] and touched_roots == []

    def test_a_local_trusted_network_path_goes_on_to_the_file_check(
        self, roots, monkeypatch
    ):
        from pydantic import ValidationError as PydanticValidationError
        from routers import artists as artists_router
        from routers.artists import ArtistModelConfig

        model_roots.add_trusted_model_folder(NAS)
        touched = _record_path_access(monkeypatch, artists_router)
        # the guard raises RuntimeError, which pydantic does not convert
        with pytest.raises((PydanticValidationError, RuntimeError)):
            ArtistModelConfig(model_source="local", model_path=NAS + r"\lsnet\best.pth")
        assert touched  # the network rule passed; the existence check ran


class TestTaggerCustomOnnxPath:
    def test_an_untrusted_network_path_is_400_before_any_filesystem_access(
        self, roots, monkeypatch
    ):
        from services.tagging import validation
        from services.tagging.request import TagRequest
        from utils import path_validation

        touched = _record_path_access(monkeypatch, path_validation)
        touched_roots = _record_path_access(monkeypatch, model_roots)
        request = TagRequest(
            model_path=r"\\attacker\s\model.onnx", custom_profile="wd14"
        )
        with pytest.raises(HTTPException) as exc:
            validation.ValidationMixin()._validate_tag_request(request)
        assert exc.value.status_code == 400
        assert "trusted" in str(exc.value.detail)
        assert touched == [] and touched_roots == []


def _record_network_access(monkeypatch, *modules):
    """Any resolve/stat/exists on a path that names a network host, through
    `Path` in the given modules or through os.stat / os.path, lands in the
    returned list and fails; local paths go through to the real calls."""
    import os as os_module

    touched = []

    def _is_network(value):
        text = str(value)
        return (
            text.startswith("\\\\")
            or text.startswith("//")
            or "attacker" in text
            or "nas" in text
        )

    real_resolve, real_stat_m, real_exists = Path.resolve, Path.stat, Path.exists
    real_is_dir, real_is_file = Path.is_dir, Path.is_file

    def _wrap(real):
        def method(self, *args, **kwargs):
            if _is_network(self):
                touched.append(str(self))
                raise RuntimeError(f"network touched: {self}")
            return real(self, *args, **kwargs)

        return method

    class _GuardedPath(Path):
        resolve = _wrap(real_resolve)
        stat = _wrap(real_stat_m)
        exists = _wrap(real_exists)
        is_dir = _wrap(real_is_dir)
        is_file = _wrap(real_is_file)

    for module in modules:
        monkeypatch.setattr(module, "Path", _GuardedPath)

    real_os_stat = os_module.stat
    real_isdir, real_isfile, real_os_exists = (
        os_module.path.isdir,
        os_module.path.isfile,
        os_module.path.exists,
    )

    def _wrap_os(real):
        def fn(path, *args, **kwargs):
            if _is_network(path):
                touched.append(str(path))
                raise RuntimeError(f"network touched: {path}")
            return real(path, *args, **kwargs)

        return fn

    monkeypatch.setattr(os_module, "stat", _wrap_os(real_os_stat))
    monkeypatch.setattr(os_module.path, "isdir", _wrap_os(real_isdir))
    monkeypatch.setattr(os_module.path, "isfile", _wrap_os(real_isfile))
    monkeypatch.setattr(os_module.path, "exists", _wrap_os(real_os_exists))
    return touched


BYPASS_FORMS = [
    "\\/attacker/share/evil.pth",
    "/\\attacker\\share\\evil.pth",
    "\\??\\UNC\\attacker\\share\\evil.pth",
    "\\\\?\\UNC\\attacker\\share\\evil.pth",
    "\\\\.\\UNC\\attacker\\share\\evil.pth",
    "//attacker/share/evil.pth",
    "\\\\attacker@SSL\\share\\evil.pth",
    "\\\\localhost\\c$\\evil.pth",
    "\u3000\\\\attacker\\share\\evil.pth",
    "\\\\nas\\share\\models\\..\\..\\other\\evil.pth",  # dot-dot out of a trusted share
]


class TestNetworkPathBypassForms:
    """Review finding 1: every spelling pathlib or Win32 reads as UNC is a
    network path, decided before any filesystem access."""

    @pytest.mark.parametrize("raw", BYPASS_FORMS)
    def test_network_path_rejection(self, roots, monkeypatch, raw):
        model_roots.add_trusted_model_folder(NAS)
        from utils import path_validation

        touched = _record_network_access(monkeypatch, model_roots, path_validation)
        assert model_roots.network_path_rejection(raw)
        assert model_roots.is_network_path(raw)
        assert touched == []

    @pytest.mark.parametrize("raw", BYPASS_FORMS[:6])
    def test_the_censor_resolver(self, roots, monkeypatch, raw):
        from services.censor_service import CensorService
        from utils import path_validation

        touched = _record_network_access(monkeypatch, model_roots, path_validation)
        with pytest.raises(HTTPException) as exc:
            CensorService._resolve_legacy_model_path(raw)
        assert exc.value.status_code == 400
        assert touched == []

    @pytest.mark.parametrize("raw", BYPASS_FORMS[:6])
    def test_the_style_finder_settings(self, roots, monkeypatch, raw):
        from pydantic import ValidationError as PydanticValidationError
        from routers import artists as artists_router
        from routers.artists import ArtistModelConfig

        touched = _record_network_access(monkeypatch, model_roots, artists_router)
        with pytest.raises(PydanticValidationError):
            ArtistModelConfig(model_source="local", model_path=raw)
        assert touched == []

    @pytest.mark.parametrize(
        "raw", [form.replace(".pth", ".onnx") for form in BYPASS_FORMS[:6]]
    )
    def test_the_custom_tagger_model(self, roots, monkeypatch, raw):
        from services.tagging import validation
        from services.tagging.request import TagRequest
        from utils import path_validation

        touched = _record_network_access(monkeypatch, model_roots, path_validation)
        request = TagRequest(model_path=raw, custom_profile="wd14")
        with pytest.raises(HTTPException) as exc:
            validation.ValidationMixin()._validate_tag_request(request)
        assert exc.value.status_code == 400
        assert touched == []

    def test_the_custom_tagger_tags_file(self, roots, monkeypatch):
        from services.tagging import validation
        from services.tagging.request import TagRequest
        from utils import path_validation

        onnx = roots.data_models / "wd14-tagger" / "model.onnx"
        onnx.parent.mkdir(parents=True)
        onnx.write_bytes(b"o")
        touched = _record_network_access(monkeypatch, model_roots, path_validation)
        request = TagRequest(
            model_path=str(onnx),
            custom_profile="wd14",
            tags_path="\\/attacker/share/selected_tags.csv",
        )
        with pytest.raises(HTTPException) as exc:
            validation.ValidationMixin()._validate_tag_request(request)
        assert exc.value.status_code == 400
        assert touched == []


class TestOfflineTrustedNas:
    """Review finding 2: a trusted NAS that is offline must cost nothing
    while local files are judged; the list never resolves or stats it."""

    def test_local_files_are_judged_without_touching_the_network_root(
        self, roots, monkeypatch
    ):
        model_roots.add_trusted_model_folder(NAS)
        inside = roots.data_models / "yolo" / "a.pt"
        inside.parent.mkdir(parents=True)
        inside.write_bytes(b"w")
        outside = roots.elsewhere / "b.pt"
        outside.write_bytes(b"w")
        from utils import path_validation

        touched = _record_network_access(monkeypatch, model_roots, path_validation)
        assert model_roots.is_under_allowed_model_root(str(inside))
        assert not model_roots.is_under_allowed_model_root(str(outside))
        assert model_roots.resolve_model_file(str(inside), {".pt"}) == str(
            inside.resolve()
        )
        assert touched == []

    def test_the_listing_does_not_check_a_network_folder(
        self, roots, monkeypatch, test_client
    ):
        model_roots.add_trusted_model_folder(NAS)
        touched = _record_network_access(monkeypatch, model_roots)
        described = model_roots.describe_trusted_model_folders()
        assert described == [{"path": NAS, "kind": "network", "exists": None}]
        response = test_client.get("/api/models/trusted-folders")
        assert response.status_code == 200, response.text
        assert response.json()["folders"][0]["exists"] is None
        assert touched == []


@pytest.fixture
def own_page_client(test_client, roots):
    """A client whose socket port is 8487, like the app's own page."""
    from main import app

    return TestClient(
        app, base_url="http://127.0.0.1:8487", client=("127.0.0.1", 50000)
    )


class TestTrustedListOwnPageOnly:
    """Review finding 3: another local web app may read the list but never
    change it (its XSS must not be able to trust an attacker's share)."""

    OTHER_PORT = {"Origin": "http://127.0.0.1:7860", "Sec-Fetch-Site": "same-site"}
    CROSS_SITE = {"Origin": "http://localhost:8188", "Sec-Fetch-Site": "cross-site"}
    OWN_PAGE = {"Origin": "http://127.0.0.1:8487", "Sec-Fetch-Site": "same-origin"}

    @pytest.mark.parametrize("method", ["POST", "DELETE"])
    @pytest.mark.parametrize("headers", [OTHER_PORT, CROSS_SITE])
    def test_other_pages_are_refused(self, own_page_client, roots, method, headers):
        response = own_page_client.request(
            method, "/api/models/trusted-folders", json={"path": NAS}, headers=headers
        )
        assert response.status_code == 403, response.text
        assert "模型中心" in response.text
        assert model_roots.list_trusted_model_folders() == []

    def test_the_own_page_and_non_browser_clients_pass(self, own_page_client, roots):
        added = own_page_client.post(
            "/api/models/trusted-folders", json={"path": NAS}, headers=self.OWN_PAGE
        )
        assert added.status_code == 200, added.text
        removed = own_page_client.request(
            "DELETE", "/api/models/trusted-folders", json={"path": NAS}
        )
        assert removed.status_code == 200, removed.text
        assert model_roots.list_trusted_model_folders() == []

    def test_reading_the_list_stays_open_to_other_local_pages(
        self, own_page_client, roots
    ):
        assert (
            own_page_client.get(
                "/api/models/trusted-folders", headers=self.OTHER_PORT
            ).status_code
            == 200
        )


class TestUncFormValidation:
    @pytest.mark.parametrize(
        "raw",
        [
            "\\\\.\\C:\\",
            "\\\\",
            "\\\\server",
            "\\\\server\\",
            "\\\\?\\C:\\models",
            "\\??\\UNC\\s\\models",
            "\\\\?\\UNC\\s\\models",
        ],
    )
    def test_malformed_or_device_unc_is_refused(self, roots, raw):
        with pytest.raises(ValueError):
            model_roots.add_trusted_model_folder(raw)
        assert model_roots.list_trusted_model_folders() == []

    def test_a_proper_share_is_accepted_and_normalised(self, roots):
        assert model_roots.add_trusted_model_folder("//nas/share/models/") == [NAS]


class TestWideFolders:
    def _wide(self, roots):
        anchor = Path(roots.elsewhere.anchor)
        return [anchor, Path.home()]

    def test_very_broad_folders_need_confirmation(self, roots):
        for folder in self._wide(roots):
            with pytest.raises(model_roots.NeedsConfirmation) as exc:
                model_roots.add_trusted_model_folder(str(folder))
            assert exc.value.reason in {"drive_root", "home", "users_root", "system"}
            assert "models" in str(exc.value)
        assert model_roots.list_trusted_model_folders() == []
        stored = model_roots.add_trusted_model_folder(str(Path.home()), confirm=True)
        assert stored == [str(Path.home().resolve())]

    def test_the_api_reports_needs_confirm_and_accepts_confirm(
        self, test_client, roots
    ):
        home = str(Path.home())
        refused = test_client.post("/api/models/trusted-folders", json={"path": home})
        assert refused.status_code == 400, refused.text
        body = refused.json()
        assert body["needs_confirm"] is True and body["reason"] in {
            "home",
            "users_root",
        }
        accepted = test_client.post(
            "/api/models/trusted-folders", json={"path": home, "confirm": True}
        )
        assert accepted.status_code == 200, accepted.text


class TestNoExistenceOracle:
    def test_outside_files_get_the_same_answer_whether_they_exist_or_not(self, roots):
        existing = roots.elsewhere / "seg.pt"
        existing.write_bytes(b"w")
        missing = roots.elsewhere / "nope.pt"
        answers = []
        for candidate in (existing, missing):
            with pytest.raises(ValueError) as exc:
                model_roots.resolve_model_file(str(candidate), {".pt"})
            answers.append(str(exc.value))
        assert answers[0] == answers[1] == model_roots.UNTRUSTED_MODEL_LOCATION_ERROR


class TestConfiguredModelDirs:
    def test_env_configured_model_folders_are_program_roots(self, roots, monkeypatch):
        import config

        yolo_dir = roots.elsewhere / "my-yolo"
        monkeypatch.setattr(config, "YOLO_MODEL_DIR", str(yolo_dir))
        assert yolo_dir.resolve() in [
            Path(r).resolve() for r in model_roots.program_model_roots()
        ]
        assert not yolo_dir.exists()  # listing roots never creates folders
        weights = yolo_dir / "seg.pt"
        weights.parent.mkdir()
        weights.write_bytes(b"w")
        assert model_roots.is_under_allowed_model_root(str(weights))


class TestUltralyticsLoadPoint:
    def test_the_detector_refuses_a_pt_outside_the_allowed_roots(
        self, roots, monkeypatch
    ):
        from censor import CensorDetector

        opened = []

        class _FakeYolo:
            def __init__(self, path):
                opened.append(path)
                self.names = {0: "face"}

        monkeypatch.setitem(
            sys.modules, "ultralytics", types.SimpleNamespace(YOLO=_FakeYolo)
        )
        outside = roots.elsewhere / "seg.pt"
        outside.write_bytes(b"w")
        with pytest.raises(RuntimeError) as exc:
            CensorDetector(model_path=str(outside))._load_with_ultralytics(str(outside))
        assert "trusted" in str(exc.value)
        assert opened == []
        inside = roots.data_models / "yolo" / "seg.pt"
        inside.parent.mkdir(parents=True)
        inside.write_bytes(b"w")
        CensorDetector(model_path=str(inside))._load_with_ultralytics(str(inside))
        assert opened == [str(inside)]


class TestStyleVectorModelPath:
    def test_the_version_follows_the_local_file_only(self, roots):
        from services.style_vector_service import _weights_path_load_would_use

        weights = roots.data_models / "artist" / "mine.pth"
        weights.parent.mkdir(parents=True)
        weights.write_bytes(b"w")
        assert _weights_path_load_would_use(None) is None
        assert _weights_path_load_would_use(str(weights)) == str(weights)
        assert _weights_path_load_would_use(str(roots.elsewhere / "gone.pth")) is None
