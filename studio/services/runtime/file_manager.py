"""Native Windows file selection without command-line quoting or a new dependency."""
from __future__ import annotations

from pathlib import Path


def reveal_file(path: Path) -> None:
    """Open Explorer with one file selected (including in an already open folder).

    FastAPI calls this from a worker thread, so initialize COM on that thread and
    balance only our own successful initialization. The PIDL is owned by us.
    """
    import ctypes
    from ctypes import wintypes

    ole32 = ctypes.WinDLL("ole32")
    shell32 = ctypes.WinDLL("shell32")
    hresult = ctypes.c_int32
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoInitializeEx.restype = hresult
    ole32.CoUninitialize.argtypes = []
    ole32.CoUninitialize.restype = None
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole32.CoTaskMemFree.restype = None
    shell32.SHParseDisplayName.argtypes = [
        wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        wintypes.DWORD, ctypes.c_void_p,
    ]
    shell32.SHParseDisplayName.restype = hresult
    shell32.SHOpenFolderAndSelectItems.argtypes = [
        ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p, wintypes.DWORD,
    ]
    shell32.SHOpenFolderAndSelectItems.restype = hresult

    def check(result: int) -> None:
        if result < 0:
            raise OSError(f"Windows Shell failed (HRESULT 0x{result & 0xFFFFFFFF:08X})")

    initialized = ole32.CoInitializeEx(None, 2)  # COINIT_APARTMENTTHREADED
    # RPC_E_CHANGED_MODE: the caller already initialized a different apartment.
    if initialized < 0 and initialized != -2147417850:
        check(initialized)
    pidl = ctypes.c_void_p()
    try:
        check(shell32.SHParseDisplayName(str(path), None, ctypes.byref(pidl), 0, None))
        # cidl=0 means pidl describes the file itself: open its parent and select it.
        check(shell32.SHOpenFolderAndSelectItems(pidl, 0, None, 0))
    finally:
        if pidl.value:
            ole32.CoTaskMemFree(pidl)
        if initialized >= 0:
            ole32.CoUninitialize()
