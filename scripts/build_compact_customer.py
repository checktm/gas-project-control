#!/usr/bin/env python3
"""Build copy-friendly Apps Script source without changing development source layout.

The compact output is an ALTERNATIVE to src/, never deploy both sets of .gs files.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

INCLUDE = re.compile(r"<\?!=\s*include\(['\"]([A-Za-z0-9_]+)['\"]\);\s*\?>")

def build(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    index = (source / "Index.html").read_text(encoding="utf-8")
    names = INCLUDE.findall(index)
    if not names:
        raise ValueError("Index.html has no includes; refusing to create an empty bundle")
    if len(names) != len(set(names)):
        raise ValueError("Repeated include found; review before bundling")
    css_names = [name for name in names if name.endswith("Styles") or name == "Styles"]
    js_names = [name for name in names if name not in css_names]
    # CSS/JS order must match original template; verify CSS is before JS.
    if names != css_names + js_names:
        raise ValueError("Interleaved style/script includes are not supported")
    for name in names:
        path = source / (name + ".html")
        if not path.is_file():
            raise ValueError(f"Missing include: {path}")
    def combine(parts: list[str]) -> str:
        return "\n".join(
            f"<!-- bundled from {name}.html -->\n" + (source / (name + ".html")).read_text(encoding="utf-8")
            for name in parts
        ) + "\n"
    (destination / "CustomerStyles.html").write_text(combine(css_names), encoding="utf-8")
    (destination / "CustomerScripts.html").write_text(combine(js_names), encoding="utf-8")
    replacement = {name: ("CustomerStyles" if name in css_names else "CustomerScripts") for name in names}
    seen = set()
    def replace(match: re.Match[str]) -> str:
        target = replacement[match.group(1)]
        if target in seen:
            return ""
        seen.add(target)
        return "<?!= include('" + target + "'); ?>"
    rendered = INCLUDE.sub(replace, index)
    remaining = INCLUDE.findall(rendered)
    if remaining != ["CustomerStyles", "CustomerScripts"]:
        raise ValueError(f"Unexpected rewritten includes: {remaining}")
    (destination / "Index.html").write_text(rendered, encoding="utf-8")

    backend = sorted(
        path for path in source.glob("*.gs")
        if path.name not in {"Code.gs", "DeploymentSecrets.gs"}
    )
    if not backend:
        raise ValueError("No backend .gs files found")
    code = "\n".join(
        f"// --- bundled from {p.name} ---\n" + p.read_text(encoding="utf-8") + "\n"
        for p in backend
    )
    (destination / "CustomerBackend.gs").write_text(code, encoding="utf-8")
    (destination / "Code.gs").write_text((source / "Code.gs").read_text(encoding="utf-8"), encoding="utf-8")
    (destination / "appsscript.json").write_text((source / "appsscript.json").read_text(encoding="utf-8"), encoding="utf-8")
    (destination / "MIGRATION.txt").write_text(
        "COMPACT SOURCE MIGRATION\n"
        "1. Back up the existing customer Apps Script project.\n"
        "2. Replace the Index.html content with this compact Index.html.\n"
        "3. Create CustomerStyles.html and CustomerScripts.html.\n"
        "4. Create CustomerBackend.gs, then DELETE all old .gs files it replaced.\n"
        "   Keep Code.gs and DeploymentSecrets.gs (customer-specific values).\n"
        "   Do not run old and compact backend together: duplicate declarations.\n"
        "5. Old individual HTML files can remain temporarily; compact Index does not include them.\n"
        "6. Verify setup, triggers, Web app authorization and deployment.\n"
        "7. For subsequent releases update only CustomerBackend.gs, CustomerStyles.html,\n"
        "   CustomerScripts.html and Index.html when changed.\n"
        "Do not overwrite customer spreadsheet IDs, secrets or authorization settings.\n"
        "This workflow requires no new OAuth scopes; it does not deploy automatically.\n",
        encoding="utf-8"
    )
    print(f"Compact: {len(backend)} GS files -> CustomerBackend.gs; "
          f"{len(css_names)} CSS + {len(js_names)} JS HTML -> 2 HTML files")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", default="src")
    parser.add_argument("--dest", required=True)
    args = parser.parse_args()
    build(Path(args.src), Path(args.dest))
