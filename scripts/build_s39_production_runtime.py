#!/usr/bin/env python3
"""Build the pinned Atlas runtime as a fail-closed, undeployed S39 artifact."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "docs/release/Atlas_S39_Production_Launch_Manifest.json"
S41_ADDENDUM_PATH = ROOT / "docs/release/Atlas_S41_Production_Function_Addendum.json"
NON_PRODUCTION_PROJECT_REFS = (
    "atialqebqxcquzdkezln",
    "uhbamqetppqmygesoeeh",
    "cwazoxupbwxnixpmmlhx",
)


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _browser_origin(value):
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.params
        or parsed.query
        or parsed.fragment
        or "*" in value
        or parsed.hostname is None
        or parsed.hostname.endswith("supabase.co")
        or parsed.hostname.endswith("chatgpt.site")
    ):
        raise ValueError("Browser origin must be one exact approved production HTTPS origin")
    return f"https://{parsed.netloc}"


def _entrypoint(function):
    preferred = {
        "atlas-reports": "entrypoint.ts",
        "atlas-stock-counts": "entrypoint.ts",
    }.get(function["name"], "index.ts")
    matches = [path for path in function["sources"] if Path(path).name == preferred]
    if len(matches) != 1:
        raise ValueError(f"Expected one {preferred} for {function['name']}")
    return matches[0]


def _helpers(target_origin, typed):
    return_type = ": string" if typed else ""
    return f'''// S41 production identity helpers.
const S39_TARGET_ORIGIN = "{target_origin}";
function atlasAuthProjectUrl(){return_type} {{
  const value = Deno.env.get("ATLAS_AUTH_PROJECT_URL") ?? Deno.env.get("SUPABASE_URL") ?? "";
  if (value !== S39_TARGET_ORIGIN) throw new Error("Atlas Auth project mismatch");
  return value;
}}
function atlasAuthPublishableKey(){return_type} {{
  const configured = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY");
  let managed = "";
  try {{
    managed = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{{}}")?.default ?? "";
  }} catch {{
    managed = "";
  }}
  const value = configured ?? managed;
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) {{
    throw new Error("Atlas publishable key is unavailable");
  }}
  return value;
}}
'''


def _guard():
    return '''// S41 production boundary: fail closed before registering a handler.
if (
  Deno.env.get("SUPABASE_URL") !== S39_TARGET_ORIGIN ||
  Deno.env.get("ATLAS_IMPORT_ENABLED") === "true" ||
  Deno.env.get("ATLAS_STOCK_COUNT_PUBLICATION_ENABLED") === "true" ||
  Deno.env.get("ATLAS_PUSH_DELIVERY_ENABLED") === "true"
) {
  throw new Error("S39 requires exact production configuration with all write flags disabled");
}

'''


def _transform(source, target_origin, browser_origin, add_guard, typed):
    for project_ref in NON_PRODUCTION_PROJECT_REFS:
        source = source.replace(f"https://{project_ref}.supabase.co", target_origin)
    source = source.replace(
        "https://atlas-s32-rehearsal.coffee-cockt-8589.chatgpt.site",
        browser_origin,
    )

    source = re.sub(
        r'const AUTH_PROJECT_URL = Deno\.env\.get\("ATLAS_AUTH_PROJECT_URL"\)'
        r'\s*\?\?\s*"[^"]+";',
        "const AUTH_PROJECT_URL = atlasAuthProjectUrl();",
        source,
    )
    source = re.sub(
        r'const AUTH_PUBLISHABLE_KEY = Deno\.env\.get\("ATLAS_AUTH_PUBLISHABLE_KEY"\)'
        r'\s*\?\?\s*"[^"]+";',
        "const AUTH_PUBLISHABLE_KEY = atlasAuthPublishableKey();",
        source,
    )
    source = source.replace('requiredEnv("ATLAS_AUTH_PROJECT_URL")', "atlasAuthProjectUrl()")
    source = source.replace('requiredEnv("ATLAS_AUTH_PUBLISHABLE_KEY")', "atlasAuthPublishableKey()")
    source = source.replace('Deno.env.get("ATLAS_AUTH_PROJECT_URL")', "atlasAuthProjectUrl()")
    source = source.replace("Deno.env.get('ATLAS_AUTH_PROJECT_URL')", "atlasAuthProjectUrl()")
    source = source.replace('Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")', "atlasAuthPublishableKey()")
    source = source.replace("Deno.env.get('ATLAS_AUTH_PUBLISHABLE_KEY')", "atlasAuthPublishableKey()")
    if "Review-only S33 source" in source and "Deno.serve(createHandler({" in source:
        source = source.replace(
            "Deno.serve(createHandler({",
            "if (Deno.env.get('ATLAS_IMPORT_ENABLED') === 'true') {\n  Deno.serve(createHandler({",
            1,
        )
        head, separator, tail = source.rpartition("}));")
        if not separator:
            raise ValueError("Import worker entrypoint shape changed")
        source = head + "}));\n} else {\n  Deno.serve(async () => new Response(JSON.stringify({ error: 'Import is disabled.' }), {\n    status: 503,\n    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '" + browser_origin + "' },\n  }));\n}" + tail
    source = source.replace("${AUTH_PROJECT_URL}/rest/v1/", "${S39_TARGET_ORIGIN}/rest/v1/")
    source = source.replace(
        '"access-control-allow-origin": "*"',
        f'"access-control-allow-origin": "{browser_origin}"',
    )
    source = source.replace(
        "'access-control-allow-origin': '*'",
        f"'access-control-allow-origin': '{browser_origin}'",
    )

    if any(project_ref in source for project_ref in NON_PRODUCTION_PROJECT_REFS):
        raise ValueError("A non-production Supabase project reference remains")
    if re.search(
        r'access-control-allow-origin["\']?\s*:\s*["\']\*["\']',
        source,
        re.IGNORECASE,
    ):
        raise ValueError("Wildcard CORS remains in generated runtime")
    needs_helpers = add_guard or "atlasAuthProjectUrl()" in source or "atlasAuthPublishableKey()" in source
    prefix = _helpers(target_origin, typed) if needs_helpers else ""
    return prefix + (_guard() if add_guard else "") + source


def build(destination, browser_origin):
    destination = Path(destination).resolve()
    browser_origin = _browser_origin(browser_origin)
    if destination.exists() or destination.is_symlink():
        raise ValueError("Output must be a new path")
    if destination == ROOT.resolve() or ROOT.resolve() in destination.parents:
        raise ValueError("Build outside the repository")

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    target_origin = manifest["production_target"]["origin"]
    source_manifest_path = ROOT / manifest["runtime"]["source_manifest"]
    if _sha256(source_manifest_path) != manifest["runtime"]["source_manifest_sha256"]:
        raise ValueError("Reviewed function-source manifest changed")
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    addendum = json.loads(S41_ADDENDUM_PATH.read_text(encoding="utf-8"))
    if addendum["base_source_manifest"] != manifest["runtime"]["source_manifest"]:
        raise ValueError("S41 addendum base manifest mismatch")
    if addendum["base_source_manifest_sha256"] != manifest["runtime"]["source_manifest_sha256"]:
        raise ValueError("S41 addendum base fingerprint mismatch")
    if addendum["production_target"] != manifest["production_target"]["project_ref"]:
        raise ValueError("S41 addendum production target mismatch")
    if addendum["boundaries"] != {
        "real_stock_writes_authorized": False,
        "item_master_publication_enabled": False,
        "wildcard_cors_allowed": False,
    }:
        raise ValueError("S41 addendum boundaries changed")
    functions = source_manifest["functions"] + addendum["functions"]
    if len(functions) != 19 or len({item["name"] for item in functions}) != 19:
        raise ValueError("Expected exactly 19 approved functions")

    generated_manifest = {
        "package": "Atlas S41 production runtime artifact",
        "target_origin": target_origin,
        "allowed_browser_origin": browser_origin,
        "deployment_authorized": False,
        "endpoint_cutover_authorized": False,
        "real_stock_writes_authorized": False,
        "wildcard_cors": False,
        "safe_initial_variables": manifest["runtime"]["safe_initial_variables"],
        "functions": [],
    }

    with tempfile.TemporaryDirectory(prefix="atlas-s39-build-") as temporary:
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
                    target_origin,
                    browser_origin,
                    add_guard=source_path == entrypoint,
                    typed=Path(source_path).suffix == ".ts",
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
        (output / "config.toml").write_text("\n\n".join(config_parts) + "\n", encoding="utf-8")
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
    parser.add_argument("--browser-origin", required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.destination, args.browser_origin)))
