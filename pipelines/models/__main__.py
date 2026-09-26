"""`python -m models train|score` (run from the `pipelines/` directory,
where pythonpath=['.'] makes `models` and `pipelines` (pipelines/pipelines)
both importable top-level packages)."""
from __future__ import annotations

import sys

from .pipeline import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
