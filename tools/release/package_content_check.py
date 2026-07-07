#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import venv
import zipfile

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None  # type: ignore[assignment]


ROOT = pathlib.Path(__file__).resolve().parents[2]
NODE_PACKAGE_DIR = ROOT / "packages" / "node"
PYTHON_PACKAGE_DIR = ROOT / "packages" / "python"
PYTHON_BUILD_FRONTEND_VERSION = "1.5.0"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def read_json(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        check=False,
        text=True,
        capture_output=True,
    )


def run_checked(command: list[str], cwd: pathlib.Path = ROOT) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        fail(
            "Command failed: "
            + " ".join(command)
            + "\n"
            + result.stdout.strip()
            + "\n"
            + result.stderr.strip()
        )

    return result


def venv_python(venv_dir: pathlib.Path) -> pathlib.Path:
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"

    return venv_dir / "bin" / "python"


def parse_minimal_toml(text: str) -> dict:
    parsed: dict = {}
    current: dict = parsed

    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue

        if line.startswith("[") and line.endswith("]"):
            current = parsed
            for part in line.strip("[]").split("."):
                current = current.setdefault(part, {})
            continue

        if "=" not in line:
            continue

        key, raw_value = [part.strip() for part in line.split("=", 1)]
        if raw_value.startswith('"') and raw_value.endswith('"'):
            current[key] = raw_value.strip('"')
            continue

        if raw_value.startswith("[") and raw_value.endswith("]"):
            values = []
            for item in raw_value.strip("[]").split(","):
                item = item.strip()
                if item.startswith('"') and item.endswith('"'):
                    values.append(item.strip('"'))
            current[key] = values

    return parsed


def read_pyproject(path: pathlib.Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if tomllib is not None:
        return tomllib.loads(text)

    return parse_minimal_toml(text)


def check_node_package() -> list[str]:
    package_json = read_json(NODE_PACKAGE_DIR / "package.json")
    failures: list[str] = []
    notes: list[str] = []

    if package_json.get("name") != "googlechatai":
        failures.append("packages/node/package.json name must stay googlechatai")
    if package_json.get("license") != "Apache-2.0":
        failures.append("packages/node/package.json license must stay Apache-2.0")

    for relative_path in ["dist/index.js", "dist/index.d.ts"]:
        if not (NODE_PACKAGE_DIR / relative_path).is_file():
            failures.append(f"Node package artifact is missing: packages/node/{relative_path}")

    pack = run(["npm", "pack", "--dry-run", "--json", str(NODE_PACKAGE_DIR)])
    if pack.returncode != 0:
        failures.append(f"npm pack dry-run failed:\n{pack.stderr.strip()}")
    else:
        try:
            pack_json = json.loads(pack.stdout)
        except json.JSONDecodeError as exc:
            failures.append(f"npm pack dry-run did not return JSON: {exc}")
        else:
            files = {item["path"] for item in pack_json[0].get("files", [])}
            required = {"dist/index.js", "dist/index.d.ts", "package.json"}
            missing = sorted(required - files)
            if missing:
                failures.append(f"Node package dry-run is missing files: {', '.join(missing)}")

            forbidden_prefixes = ("src/", "test/")
            forbidden = sorted(
                file_name
                for file_name in files
                if file_name.startswith(forbidden_prefixes) or file_name.endswith(".tsbuildinfo")
            )
            if forbidden:
                failures.append(f"Node package dry-run includes source/test/build metadata: {', '.join(forbidden)}")

    if failures:
        fail("Package content check failed:\n- " + "\n- ".join(failures))

    notes.append("Node npm pack dry-run content is scoped to built dist files.")
    return notes


def check_python_package() -> list[str]:
    pyproject_path = PYTHON_PACKAGE_DIR / "pyproject.toml"
    pyproject = read_pyproject(pyproject_path)
    failures: list[str] = []
    notes: list[str] = []

    build_system = pyproject.get("build-system", {})
    if build_system.get("build-backend") != "hatchling.build":
        failures.append("Python build backend must remain hatchling.build unless a replacement is documented")

    requires = build_system.get("requires", [])
    if "hatchling>=1.30.1" not in requires:
        failures.append("Python build-system requires must include hatchling>=1.30.1")

    project = pyproject.get("project", {})
    if not project.get("name"):
        failures.append("Python project name is missing")
    if not project.get("version"):
        failures.append("Python project version is missing")
    readme = project.get("readme", "")
    if not readme or not (PYTHON_PACKAGE_DIR / readme).resolve().is_file():
        failures.append("Python project readme path does not resolve")

    for relative_path in [
        "src/googlechatai/__init__.py",
        "src/googlechatai/py.typed",
    ]:
        if not (PYTHON_PACKAGE_DIR / relative_path).is_file():
            failures.append(f"Python package content is missing: packages/python/{relative_path}")

    wheel_config = pyproject.get("tool", {}).get("hatch", {}).get("build", {}).get("targets", {}).get("wheel", {})
    if wheel_config.get("packages") != ["src/googlechatai"]:
        failures.append("Python wheel package list must include only src/googlechatai at this scaffold stage")

    if failures:
        fail("Package content check failed:\n- " + "\n- ".join(failures))

    notes.append("Python package metadata is parseable and wheel package roots are explicit.")
    notes.extend(check_python_artifacts())
    notes.append("googlechatai is published to npm and PyPI; keep versions immutable and bump before every release.")
    return notes


def check_python_artifacts() -> list[str]:
    with tempfile.TemporaryDirectory(prefix="googlechatai-python-package-") as temp_dir_name:
        temp_dir = pathlib.Path(temp_dir_name)
        venv_dir = temp_dir / "venv"
        out_dir = temp_dir / "dist"

        venv.EnvBuilder(with_pip=True).create(venv_dir)
        python = venv_python(venv_dir)
        run_checked(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                f"build=={PYTHON_BUILD_FRONTEND_VERSION}",
            ],
        )
        run_checked(
            [
                str(python),
                "-m",
                "build",
                "--sdist",
                "--wheel",
                "--outdir",
                str(out_dir),
                str(PYTHON_PACKAGE_DIR),
            ],
        )

        wheels = sorted(out_dir.glob("*.whl"))
        sdists = sorted(out_dir.glob("*.tar.gz"))
        failures: list[str] = []

        if len(wheels) != 1:
            failures.append(f"Expected one Python wheel, found {len(wheels)}")
        if len(sdists) != 1:
            failures.append(f"Expected one Python sdist, found {len(sdists)}")

        if wheels:
            with zipfile.ZipFile(wheels[0]) as wheel:
                names = set(wheel.namelist())
            for expected in [
                "googlechatai/__init__.py",
                "googlechatai/events.py",
                "googlechatai/py.typed",
            ]:
                if expected not in names:
                    failures.append(f"Python wheel is missing {expected}")

        if sdists:
            with tarfile.open(sdists[0], "r:gz") as sdist:
                names = set(sdist.getnames())
            for expected_suffix in [
                "/pyproject.toml",
                "/src/googlechatai/__init__.py",
                "/src/googlechatai/events.py",
                "/src/googlechatai/py.typed",
            ]:
                if not any(name.endswith(expected_suffix) for name in names):
                    failures.append(f"Python sdist is missing *{expected_suffix}")

        if failures:
            fail("Python artifact content check failed:\n- " + "\n- ".join(failures))

    return [
        f"Python wheel and sdist build with PyPI build frontend {PYTHON_BUILD_FRONTEND_VERSION}.",
        "Python wheel and sdist contain expected package files.",
    ]


def main() -> None:
    notes = check_node_package() + check_python_package()
    print("Package content check passed:")
    for note in notes:
        print(f"- {note}")


if __name__ == "__main__":
    main()
