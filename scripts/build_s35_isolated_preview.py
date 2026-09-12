"""Build the full S35 isolated-preview artifact without deploying or editing source."""
import argparse
import html
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = "atialqebqxcquzdkezln"
PREVIEW_ORIGIN = "https://atlas-s32-rehearsal.coffee-cockt-8589.chatgpt.site"
SOURCE_MERGE_COMMIT = "0556ec89ec8041a9d2b1f7cd94706212176884a6"
FORBIDDEN_REFS = ("dnefgcmjcgxlynycxkts", "uhbamqetppqmygesoeeh")


def _runtime_endpoints(source):
    pairs = re.findall(
        r'^  ([A-Z0-9_]+_API):\s*"https://[^/]+/functions/v1/([^"/]+)"',
        source,
        re.M,
    )
    endpoints = dict(pairs)
    endpoints["NOTIFICATIONS_API"] = "atlas-notifications"
    if len(endpoints) != 17:
        raise ValueError(f"Expected 17 runtime endpoints, found {len(endpoints)}.")
    return endpoints


def build(output, publishable_key):
    """Create a new full-app artifact outside the repository; never calls a service."""
    if not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", publishable_key):
        raise ValueError("Use a staging publishable key; secret and legacy JWT keys are rejected.")
    output = Path(output).resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError("Build outside the repository so it cannot replace or enter the app.")
    if output.exists():
        raise ValueError("Output must be a new directory; existing files are never overwritten.")

    source_path = ROOT / "apps/web/config.js"
    source = source_path.read_text()
    endpoints = _runtime_endpoints(source)
    object_end = re.search(r"\n};\n", source)
    if not object_end:
        raise ValueError("Could not isolate the reviewed VABAR_CONFIG object.")
    suffix = source[object_end.end():]
    for ref in FORBIDDEN_REFS:
        suffix = suffix.replace(f"https://{ref}.supabase.co", f"https://{TARGET}.supabase.co")

    shutil.copytree(ROOT / "apps/web", output)
    cfg = {
        "MODE": "isolated-rehearsal",
        "SUPABASE_URL": f"https://{TARGET}.supabase.co",
        "SUPABASE_ANON_KEY": publishable_key,
        "PURCHASE_ORDERS_ENABLED": True,
        **{
            key: f"https://{TARGET}.supabase.co/functions/v1/{function}"
            for key, function in endpoints.items()
        },
    }
    (output / "config.js").write_text(
        "// Generated S35 isolated-preview settings. Do not copy into production.\n"
        "window.VABAR_CONFIG = " + json.dumps(cfg, indent=2) + ";\n" + suffix
    )

    csp = (ROOT / "netlify.toml").read_text().split('Content-Security-Policy = "', 1)[1].split('"', 1)[0]
    for ref in FORBIDDEN_REFS:
        csp = csp.replace(f"https://{ref}.supabase.co", f"https://{TARGET}.supabase.co")
        csp = csp.replace(f"wss://{ref}.supabase.co", f"wss://{TARGET}.supabase.co")
    meta_csp = re.sub(r"; frame-ancestors[^;]+", "", csp)
    for page in output.rglob("*.html"):
        markup = page.read_text()
        markup = re.sub(
            r"<head(\s[^>]*)?>",
            lambda match: match.group(0) + '<meta http-equiv="Content-Security-Policy" content="' + html.escape(meta_csp, quote=True) + '">',
            markup,
            count=1,
            flags=re.I,
        )
        page.write_text(markup)
    (output / "_headers").write_text(
        "/*\n"
        f"  Content-Security-Policy: {csp}\n"
        "  Cache-Control: no-store\n"
        "  Referrer-Policy: no-referrer\n"
        "  X-Robots-Tag: noindex, nofollow\n"
    )

    boundary = output / "assets/js/rehearsal-boundary.js"
    boundary.write_text(boundary.read_text().replace(
        "Runtime modules require separate setup.",
        "Runtime modules enabled for this isolated target.",
    ))
    (output / "rehearsal-manifest.json").write_text(json.dumps({
        "package": "Atlas S35 combined isolated-staging package v1",
        "source_merge_commit": SOURCE_MERGE_COMMIT,
        "target_project_ref": TARGET,
        "preview_origin": PREVIEW_ORIGIN,
        "mode": cfg["MODE"],
        "runtime_endpoints": cfg | {"SUPABASE_ANON_KEY": "[provided outside Git]"},
        "runtime_endpoint_count": len(endpoints),
        "hosted_setup_performed": False,
        "notification_delivery_enabled": False,
        "production_changes": False,
    }, indent=2) + "\n")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--publishable-key", required=True)
    args = parser.parse_args()
    print(build(args.output, args.publishable_key))
