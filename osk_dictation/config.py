"""File locations and user settings."""
import configparser
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

ENGINES = ("moonshine-small", "moonshine-tiny", "whisper-base")
DEFAULTS_DIR = Path(__file__).resolve().parent / "defaults"


def config_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config"
    return Path(os.environ.get("OSK_DICTATION_CONFIG_DIR", Path(base) / "osk-dictation"))


def data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(os.environ.get("OSK_DICTATION_DATA_DIR", Path(base) / "osk-dictation"))


def models_dir() -> Path:
    return data_dir() / "models"


@dataclass
class Settings:
    engine: str = "moonshine-small"
    auto_stop_seconds: float = 8.0
    idle_exit_seconds: float = 600.0
    update_interval: float = 1.0

    @classmethod
    def load(cls) -> "Settings":
        settings = cls()
        parser = configparser.ConfigParser()
        parser.read(config_dir() / "settings.conf")
        section = parser["dictation"] if parser.has_section("dictation") else {}
        if section.get("engine") in ENGINES:
            settings.engine = section["engine"]
        for key in ("auto_stop_seconds", "idle_exit_seconds", "update_interval"):
            try:
                setattr(settings, key, float(section[key]))
            except (KeyError, ValueError):
                pass
        return settings

    def save(self) -> None:
        parser = configparser.ConfigParser()
        parser["dictation"] = {
            "engine": self.engine,
            "auto_stop_seconds": str(self.auto_stop_seconds),
            "idle_exit_seconds": str(self.idle_exit_seconds),
            "update_interval": str(self.update_interval),
        }
        config_dir().mkdir(parents=True, exist_ok=True)
        with open(config_dir() / "settings.conf", "w") as f:
            parser.write(f)


def ensure_user_files() -> None:
    """Copies the commented example word lists into the config folder on first run."""
    config_dir().mkdir(parents=True, exist_ok=True)
    for name in ("words.txt", "fixes.txt"):
        target = config_dir() / name
        if not target.exists() and (DEFAULTS_DIR / name).exists():
            shutil.copy(DEFAULTS_DIR / name, target)
