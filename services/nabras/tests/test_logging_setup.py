"""Where a log line lands, and whether it is written at all.

Both of these were wrong in production for the whole life of the service:
every line went to stderr (so Railway filed routine warnings as `severity:
error`) and everything below WARNING was dropped before it was written, which
is precisely the level the catalogue and package counts are logged at.
"""
import logging
import sys

from app.logging_setup import configure_logging


def _reset():
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    root.setLevel(logging.WARNING)


def test_log_lines_go_to_stdout_not_stderr():
    """A stderr line is an `error` in the log viewer, whatever its level."""
    _reset()
    configure_logging("INFO")
    streams = [h.stream for h in logging.getLogger().handlers
               if isinstance(h, logging.StreamHandler)]
    assert streams, "the root logger still has no handler"
    assert all(s is sys.stdout for s in streams), streams
    assert not any(s is sys.stderr for s in streams)


def test_info_is_actually_emitted(capsys):
    """`lastResort` is pinned at WARNING — every log.info was being discarded."""
    _reset()
    configure_logging("INFO")
    logging.getLogger("nabras.catalog").info("packages refreshed: %d", 12)
    out = capsys.readouterr()
    assert "packages refreshed: 12" in out.out
    assert out.err == ""


def test_uvicorn_startup_lines_are_moved_off_stderr():
    """"Application startup complete" is not an error, and was logged as one."""
    _reset()
    uvi = logging.getLogger("uvicorn.error")
    for h in list(uvi.handlers):
        uvi.removeHandler(h)
    uvi.addHandler(logging.StreamHandler(sys.stderr))   # uvicorn's own default
    configure_logging("INFO")
    assert all(h.stream is sys.stdout for h in uvi.handlers
               if isinstance(h, logging.StreamHandler))


def test_an_unknown_level_falls_back_instead_of_crashing_boot():
    """A typo in LOG_LEVEL must not be the reason the service will not start."""
    _reset()
    configure_logging("chatty")
    assert logging.getLogger().level == logging.INFO


def test_noisy_dependencies_do_not_bury_our_own_lines():
    _reset()
    configure_logging("INFO")
    assert logging.getLogger("httpx").level >= logging.WARNING
