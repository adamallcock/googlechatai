#!/usr/bin/env python3
"""Lightweight Python package static checks for release validation."""

from __future__ import annotations

import ast
import compileall
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / "packages" / "python" / "src"
TEST_ROOT = ROOT / "packages" / "python" / "tests"
CAMEL_CASE = re.compile(r"[a-z][A-Z]")


def snake_alias(name: str) -> str:
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name).lower()


def public_function_keyword_issues(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    issues: list[str] = []

    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name.startswith("_"):
            continue

        args = [arg.arg for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]]
        arg_names = set(args)
        for arg_name in args:
            if not CAMEL_CASE.search(arg_name):
                continue
            alias_name = snake_alias(arg_name)
            if alias_name not in arg_names:
                rel = path.relative_to(ROOT)
                issues.append(
                    f"{rel}:{node.lineno} public function {node.name} exposes {arg_name} without {alias_name}",
                )

    return issues


def main() -> int:
    if not compileall.compile_dir(SOURCE_ROOT, quiet=1):
        return 1
    if not compileall.compile_dir(TEST_ROOT, quiet=1):
        return 1

    issues: list[str] = []
    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        issues.extend(public_function_keyword_issues(path))

    if issues:
        sys.stderr.write("Python public keyword style check failed:\n")
        sys.stderr.write("\n".join(issues))
        sys.stderr.write("\n")
        return 1

    print("Python static check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
