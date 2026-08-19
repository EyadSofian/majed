"""One place that decides where a log line goes, and at what level.

Two separate defects made the production log unreadable, and both are fixed
here rather than in each module:

1. **Everything looked like an error.** Nothing in the service ever called
   `logging.basicConfig`, so the root logger had no handler and Python fell
   back to `logging.lastResort` — which writes to **stderr**. Railway (like
   most PaaS log shippers) classifies a stderr line as `severity: error`, so a
   routine `log.warning` arrived looking identical to a crash. uvicorn does the
   same thing to itself: its startup handler is pinned to stderr while only the
   access handler uses stdout, which is why "Application startup complete" was
   filed as an error and `GET /health 200 OK` was not.

2. **Half the log was missing.** `logging.lastResort` is fixed at WARNING, so
   every `log.info` in this service — catalogue sizes, package counts, which
   source the packages came from, prompt rebuilds — was discarded before it was
   written. The lines needed to answer "is the data actually loading?" were the
   exact ones being dropped.

Both are one-line consequences of never configuring logging, so this module is
imported for its effect by `app.main` before anything else logs.
"""
import logging
import sys

FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"
DATEFMT = "%Y-%m-%dT%H:%M:%S"

# uvicorn owns these and sets `propagate = False`, so a root handler alone
# never reaches them; their handlers have to be retargeted in place.
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")


def _to_stdout(logger: logging.Logger) -> None:
    for h in logger.handlers:
        if isinstance(h, logging.StreamHandler) and \
                getattr(h, "stream", None) is sys.stderr:
            h.setStream(sys.stdout)


def configure_logging(level: str = "INFO") -> None:
    """Send every log line to stdout at *level*. Safe to call more than once."""
    resolved = getattr(logging, str(level).strip().upper(), logging.INFO)
    if not isinstance(resolved, int):
        resolved = logging.INFO
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(FORMAT, datefmt=DATEFMT))
    root = logging.getLogger()
    for old in list(root.handlers):
        root.removeHandler(old)
    root.addHandler(handler)
    root.setLevel(resolved)
    # uvicorn is configured before our app module is imported, so its handlers
    # already exist by the time this runs.
    for name in _UVICORN_LOGGERS:
        _to_stdout(logging.getLogger(name))
    # Chatty third parties would bury our own lines at INFO.
    for noisy in ("httpx", "httpcore", "openai", "urllib3"):
        logging.getLogger(noisy).setLevel(max(resolved, logging.WARNING))
