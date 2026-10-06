"""Verify wheel and source-distribution consumers in isolated environments."""

import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

root = Path(__file__).resolve().parent.parent
for pattern in ("*.whl", "*.tar.gz"):
    with TemporaryDirectory(prefix="lo-python-consumer-") as directory:
        environment = Path(directory)
        subprocess.run([sys.executable, "-m", "venv", directory], check=True)
        python = environment / "bin" / "python"
        packages = sorted(root.glob(f"python/*/dist/{pattern}"))
        if len(packages) != 2:
            raise ValueError("Expected one distribution per published Python package")
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "-r",
                str(root / "compatibility/aiogram/requirements.txt"),
                *map(str, packages),
            ],
            check=True,
        )
        subprocess.run(
            [str(python), "-m", "unittest", "discover", "-s", str(root / "python/tests"), "-v"],
            check=True,
            cwd=directory,
        )
