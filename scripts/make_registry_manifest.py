"""Create registry metadata only after the operator supplies a real HTTPS endpoint."""

import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, default=Path("server.json"))
    args = parser.parse_args()
    url = urlsplit(args.url)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.path != "/mcp"
        or url.query
        or url.fragment
        or url.username
        or url.password
        or url.hostname in {"localhost", "127.0.0.1", "example.com"}
        or url.hostname.endswith((".example.com", ".invalid", ".example"))
    ):
        parser.error(
            "Supply the deployed HTTPS URL ending in /mcp, without credentials or parameters."
        )
    template = Path(__file__).resolve().parents[1] / "registry/server.json.template"
    manifest = json.loads(template.read_text())
    manifest["remotes"][0]["url"] = args.url
    args.output.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Created {args.output} for {args.url}")


if __name__ == "__main__":
    main()
