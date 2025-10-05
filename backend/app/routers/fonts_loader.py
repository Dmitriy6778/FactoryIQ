# backend/app/fonts_loader.py
from __future__ import annotations
import os
import threading
from functools import lru_cache
from typing import Iterable, List, Optional, Set, Tuple, Union

import matplotlib
import matplotlib.font_manager as fm

_FONTS_READY = False
_LOCK = threading.Lock()

_ALIAS = {
    "system": "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, Ubuntu, sans-serif",
    "Inter": "Inter",
    "Segoe UI": "Segoe UI",
    "Roboto": "Roboto",
    "Roboto Condensed": "Roboto Condensed",
    "Roboto Mono": "Roboto Mono",
    "Open Sans": "Open Sans",
    "Montserrat": "Montserrat",
    "Poppins": "Poppins",
    "Raleway": "Raleway",
    "Lato": "Lato",
    "Inconsolata": "Inconsolata",
    "Monospace": "Inconsolata",
}

_FALLBACKS: Tuple[str, ...] = ("Roboto Condensed", "Roboto", "Open Sans", "Montserrat", "DejaVu Sans", "Arial")


def _scan_fonts_dir(fonts_dir: str) -> List[str]:
    paths: List[str] = []
    if not fonts_dir:
        return paths
    fonts_dir = os.path.abspath(fonts_dir)
    if not os.path.isdir(fonts_dir):
        return paths
    for root, _, files in os.walk(fonts_dir):
        for f in files:
            if f.lower().endswith((".ttf", ".otf")):
                paths.append(os.path.join(root, f))
    return paths


def _candidate_fonts_dirs() -> List[str]:
    """
    Возвращает список директорий, где ищем шрифты проекта.
    - backend/app/fonts
    - backend/fonts
    - путь из переменной окружения FACTORYIQ_FONTS_DIR (если задан)
    """
    here = os.path.abspath(os.path.dirname(__file__))                 # backend/app
    app_fonts = os.path.join(here, "fonts")                           # backend/app/fonts
    project_fonts = os.path.abspath(os.path.join(here, "..", "fonts"))# backend/fonts
    env_fonts = os.environ.get("FACTORYIQ_FONTS_DIR", "").strip()
    out: List[str] = []
    for p in (app_fonts, project_fonts, env_fonts):
        if p and os.path.isdir(p):
            out.append(p)
    # убрать дубликаты, сохранить порядок
    seen = set()
    uniq = []
    for p in out:
        if p not in seen:
            uniq.append(p); seen.add(p)
    return uniq


def register_fonts() -> None:
    """
    Регистрирует все шрифты из известных путей (рекурсивно).
    Безопасно вызывать многократно.
    """
    for base in _candidate_fonts_dirs():
        for path in _scan_fonts_dir(base):
            try:
                fm.fontManager.addfont(path)
            except Exception:
                continue
    # addfont достаточно; лишний перезагруз кэша не нужен


def ensure_fonts_ready() -> None:
    global _FONTS_READY
    if _FONTS_READY:
        return
    with _LOCK:
        if _FONTS_READY:
            return
        register_fonts()
        _FONTS_READY = True


def _split_candidates(req: Union[str, Iterable[str]]) -> List[str]:
    if isinstance(req, (list, tuple, set)):
        return [str(x).strip() for x in req if str(x).strip()]
    s = (req or "").strip()
    if not s:
        return []
    if "," in s:
        return [x.strip() for x in s.split(",") if x.strip()]
    return [s]


@lru_cache(maxsize=1)
def _available_families() -> Set[str]:
    return {f.name for f in fm.fontManager.ttflist if getattr(f, "name", None)}


def _family_exists(name: str) -> bool:
    return name in _available_families()


def _family_from_file(path: str) -> Optional[str]:
    try:
        f = fm.get_font(path)
        return f.family_name or None
    except Exception:
        return None


def pick_font_family(requested: Optional[Union[str, Iterable[str]]]) -> str:
    ensure_fonts_ready()

    default_req = "Roboto Condensed"
    req: Union[str, Iterable[str]] = (requested or "").strip() if isinstance(requested, str) else (requested or [])
    if not req:
        req = default_req
    if isinstance(req, str) and req in _ALIAS:
        req = _ALIAS[req]
    candidates = _split_candidates(req)

    resolved: List[str] = []
    for cand in candidates:
        if os.path.isfile(cand):
            fam = _family_from_file(cand)
            if fam:
                resolved.append(fam)
        else:
            resolved.append(cand)

    for fam in resolved:
        if _family_exists(fam):
            return fam
    for fam in _FALLBACKS:
        if _family_exists(fam):
            return fam
    return "DejaVu Sans"


def _find_font_path_by_family(family: str) -> Optional[str]:
    """
    Возвращает путь к ПЕРВОМУ шрифту данного семейства.
    Сначала ищем в папках проекта, затем — что угодно системное.
    """
    # 1) приоритет — файлы из проекта
    project_dirs = _candidate_fonts_dirs()
    project_dirs_set = {os.path.abspath(d) for d in project_dirs}

    for f in fm.fontManager.ttflist:
        try:
            if getattr(f, "name", None) == family and getattr(f, "fname", None):
                fpath = os.path.abspath(f.fname)
                # свой шрифт?
                if any(fpath.startswith(d + os.sep) or fpath == d for d in project_dirs_set):
                    return fpath
        except Exception:
            continue

    # 2) иначе — первый попавшийся (системный)
    for f in fm.fontManager.ttflist:
        try:
            if getattr(f, "name", None) == family and getattr(f, "fname", None):
                return f.fname
        except Exception:
            continue
    return None


def resolve_font(requested: str) -> Tuple[str, Optional[str]]:
    """
    Возвращает (family_name, file_path_or_None) для запрошенного шрифта,
    стараясь отдать именно ФАЙЛ из проекта (если он есть).
    """
    ensure_fonts_ready()

    # точное семейство (или ближайшее)
    fam = pick_font_family(requested)
    path = _find_font_path_by_family(fam)

    # Доп. защита: если явно просили "Condensed", а путь оказался системным Roboto — ищем руками в проекте.
    if "condensed" in (requested or "").lower() and (not path or "\\Windows\\Fonts" in path or "/Fonts/" in path):
        for base in _candidate_fonts_dirs():
            for root, _, files in os.walk(base):
                for f in files:
                    if f.lower().endswith(".ttf") and "condensed" in f.lower():
                        return fam, os.path.join(root, f)

    return fam, path


def apply_matplotlib_font(requested: Optional[Union[str, Iterable[str]]] = None) -> str:
    ensure_fonts_ready()
    chosen = pick_font_family(requested)
    matplotlib.rcParams["font.family"] = chosen
    ss = list(matplotlib.rcParams.get("font.sans-serif", []))
    if chosen not in ss:
        matplotlib.rcParams["font.sans-serif"] = [chosen] + ss
    return chosen
