#!/usr/bin/env python3
"""Build the reviewed S35 functions as a fail-closed S37 staging artifact."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "docs/release/Atlas_S35_Combined_Isolated_Staging_Manifest.json"
TARGET_ORIGIN = "https://atialqebqxcquzdkezln.supabase.co"
PREVIEW_ORIGIN = "https://atlas-s32-rehearsal.coffee-cockt-8589.chatgpt.site"
FORBIDDEN_PROJECT_REFS = (
    "dnefgcmjcgxlynycxkts",
    "uhbamqetppqmygesoeeh",
    "cwazoxupbwxnixpmmlhx",
)
GUARD = f"""// S37 staging boundary: reject unsafe configuration before registering a handler.
const S37_TARGET_ORIGIN = "{TARGET_ORIGIN}";
if (
  Deno.env.get("SUPABASE_URL") !== S37_TARGET_ORIGIN ||
  Deno.env.get("ATLAS_AUTH_PROJECT_URL") !== S37_TARGET_ORIGIN ||
  !/^sb_publishable_[A-Za-z0-9_-]+$/.test(
    Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY") ?? "",
  )
) {{
  throw new Error("S37 requires explicit isolated staging Auth and runtime configuration");
}}

"""


def _entrypoint(function):
    sources = list(function["sources"])
    preferred = {
        "atlas-reports": "entrypoint.ts",
        "atlas-stock-counts": "entrypoint.ts",
    }.get(function["name"], "index.ts")
    matches = [path for path in sources if Path(path).name == preferred]
    if len(matches) != 1:
        raise ValueError(f"Expected one {preferred} for {function['name']}")
    return matches[0]


def _transform(source, add_guard):
    for ref in FORBIDDEN_PROJECT_REFS:
        source = source.replace(
            f"https://{ref}.supabase.co",
            TARGET_ORIGIN,
        )

    source = re.sub(
        r'(const AUTH_PROJECT_URL = Deno\.env\.get\("ATLAS_AUTH_PROJECT_URL"\))'
        r'\s*\?\?\s*"[^"]+";',
        r"\1!;",
        source,
    )
    source = re.sub(
        r'(const AUTH_PUBLISHABLE_KEY = Deno\.env\.get\("ATLAS_AUTH_PUBLISHABLE_KEY"\))'
        r'\s*\?\?\s*"[^"]+";',
        r"\1!;",
        source,
    )
    # Authentication still uses the explicit Auth client. Operational REST data
    # is always read from the exact isolated runtime origin guarded above.
    source = source.replace(
        "${AUTH_PROJECT_URL}/rest/v1/",
        "${S37_TARGET_ORIGIN}/rest/v1/",
    )
    source = re.sub(r"\bproductionRows\b", "isolatedRows", source)
    source = source.replace(
        "production_rest_snapshot",
        "isolated_staging_rest_snapshot",
    )
    source = re.sub(
        r"\bproduction_source_mutation\b",
        "isolated_source_mutation",
        source,
    )
    source = source.replace(
        '"access-control-allow-origin": "*"',
        f'"access-control-allow-origin": "{PREVIEW_ORIGIN}"',
    )
    source = source.replace(
        "'access-control-allow-origin': '*'",
        f"'access-control-allow-origin': '{PREVIEW_ORIGIN}'",
    )

    if any(ref in source for ref in FORBIDDEN_PROJECT_REFS):
        raise ValueError("A forbidden Supabase project reference remains")
    if re.search(
        r'access-control-allow-origin["\']?\s*:\s*["\']\*["\']',
        source,
        re.I,
    ):
        raise ValueError("Wildcard CORS remains in generated runtime")
    return (GUARD if add_guard else "") + source


def build(destination):
    destination = Path(destination).resolve()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Output must be a new path")
    if destination == ROOT.resolve() or ROOT.resolve() in destination.parents:
        raise ValueError("Build outside the repository")

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    functions = manifest["functions"]
    if len(functions) != 18 or len({item["name"] for item in functions}) != 18:
        raise ValueError("Expected exactly 18 reviewed functions")

    generated_manifest = {
        "package": "Atlas S37 isolated runtime artifact",
        "target_origin": TARGET_ORIGIN,
        "allowed_browser_origin": PREVIEW_ORIGIN,
        "production_fallbacks": False,
        "wildcard_cors": False,
        "deployed": False,
        "functions": [],
    }

    with tempfile.TemporaryDirectory(prefix="atlas-s37-build-") as temporary:
        output = Path(temporary)
        for function in functions:
            entrypoint = _entrypoint(function)
            generated_files = []
            for source_path, expected_hash in function["sources"].items():
                path = ROOT / source_path
                if path.is_symlink() or not path.is_file():
                    raise ValueError(f"Invalid reviewed source: {source_path}")
                raw = path.read_bytes()
                if hashlib.sha256(raw).hexdigest() != expected_hash:
                    raise ValueError(f"Source fingerprint changed: {source_path}")
                generated = _transform(
                    raw.decode("utf-8"),
                    add_guard=source_path == entrypoint,
                ).encode("utf-8")
                relative = Path("functions") / function["name"] / Path(source_path).name
                target = output / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(generated)
                generated_files.append({
                    "path": str(relative),
                    "source_sha256": expected_hash,
                    "candidate_sha256": hashlib.sha256(generated).hexdigest(),
                })
            generated_manifest["functions"].append({
                "name": function["name"],
                "entrypoint": str(Path("functions") / function["name"] / Path(entrypoint).name),
                "verify_jwt": function["name"] == "atlas-notifications",
                "files": generated_files,
            })

        config_parts = []
        for function in generated_manifest["functions"]:
            config_parts.append(
                f"[functions.{function['name']}]\n"
                f"verify_jwt = {'true' if function['verify_jwt'] else 'false'}\n"
                f"entrypoint = \"./{function['entrypoint']}\""
            )
        (output / "config.toml").write_text(
            "\n\n".join(config_parts) + "\n",
            encoding="utf-8",
        )
        (output / "runtime-manifest.json").write_text(
            json.dumps(generated_manifest, indent=2) + "\n",
            encoding="utf-8",
        )
        shutil.copytree(output, destination)

    return {
        "functions": len(generated_manifest["functions"]),
        "files": sum(len(item["files"]) for item in generated_manifest["functions"]),
        "deployed": False,
        "output": str(destination),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    print(json.dumps(build(parser.parse_args().destination)))
