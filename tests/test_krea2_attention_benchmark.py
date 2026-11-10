"""Benchmark safety: busy/unknown GPUs must not start work."""
from types import SimpleNamespace

import pytest

from tools import benchmark_krea2_attention as bench


def _telemetry(monkeypatch, processes="", utilization="0 %"):
    xml = (f"<nvidia_smi_log><gpu><processes>{processes}</processes>"
           f"<utilization><gpu_util>{utilization}</gpu_util></utilization>"
           "</gpu></nvidia_smi_log>")
    monkeypatch.setattr(bench.subprocess, "run", lambda *a, **kw: SimpleNamespace(stdout=xml))


@pytest.mark.parametrize("kind,name", [("C", "trainer"), ("C+G", "python.exe"), ("", "unknown")])
def test_rejects_other_compute_processes(monkeypatch, kind, name):
    _telemetry(monkeypatch, f"<process_info><pid>9999999</pid><type>{kind}</type>"
               f"<process_name>{name}</process_name></process_info>")
    with pytest.raises(RuntimeError, match="GPU busy"):
        bench.require_idle_gpu()


def test_accepts_idle_desktop_and_own_compute_context(monkeypatch):
    _telemetry(monkeypatch, "<process_info><pid>9999999</pid><type>C+G</type>"
               "<process_name>explorer.exe</process_name></process_info>"
               f"<process_info><pid>{bench.os.getpid()}</pid><type>C</type>"
               "<process_name>python.exe</process_name></process_info>")
    bench.require_idle_gpu(check_utilization=True)


@pytest.mark.parametrize("usage", ["99 %", "N/A"])
def test_rejects_busy_or_unknown_utilization(monkeypatch, usage):
    _telemetry(monkeypatch, utilization=usage)
    with pytest.raises(RuntimeError, match="not idle"):
        bench.require_idle_gpu(check_utilization=True)


def test_missing_telemetry_fails_closed(monkeypatch):
    monkeypatch.setattr(bench.subprocess, "run", lambda *a, **kw: SimpleNamespace(stdout="<nvidia_smi_log/>"))
    with pytest.raises(RuntimeError, match="No GPU telemetry"):
        bench.require_idle_gpu()
