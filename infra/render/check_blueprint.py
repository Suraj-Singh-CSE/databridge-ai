"""Checks render.yaml against both services' config schemas (docs/adr/0031-render-blueprint.md).

Run from the repo root (needs PyYAML, pydantic and pydantic-settings):

    python infra/render/check_blueprint.py                      # all checks
    python infra/render/check_blueprint.py --emit-env databridge-api > env.json

It fails when:
- a service is not on the free plan or not in the deploy region, a Dockerfile is missing, a web
  service has no health check, or the Key Value instance has no ipAllowList;
- an env var entry is malformed, duplicated, or references a service, variable or group that the
  Blueprint does not define;
- a variable a service requires at startup (read from apps/api/src/config.ts and
  apps/ai-service/app/config.py) is missing: it must have a value, generateValue, fromService or
  sync: false;
- a variable is not read by the service it is set on (a typo would be silently ignored);
- the ai-service settings do not validate with the Blueprint's values (stand-in values for secrets).

--emit-env prints one service's environment as JSON, with the same stand-ins, so CI can pass it to
the api's own loadConfig().
"""

import argparse
import ast
import json
import re
import secrets
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
BLUEPRINT = ROOT / "render.yaml"
API_CONFIG = ROOT / "apps/api/src/config.ts"
AI_CONFIG = ROOT / "apps/ai-service/app/config.py"

API_SERVICE = "databridge-api"
AI_SERVICE = "databridge-ai"
REGION = "singapore"
# Set by Render itself, never in the Blueprint.
PLATFORM_KEYS = {"PORT", "RENDER_EXTERNAL_URL"}

# Requirements the schemas enforce in refinements/validators rather than per field:
# (service, key, value) -> keys that must then be present.
CONDITIONAL: list[tuple[str, str, str, list[str]]] = [
    (API_SERVICE, "REGISTRATION_MODE", "invite", ["REGISTRATION_INVITE_CODES"]),
    # R2 needs the account endpoint and a token: the default AWS credential chain cannot reach it.
    (
        API_SERVICE,
        "STORAGE_DRIVER",
        "s3",
        ["S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
    ),
    (
        AI_SERVICE,
        "STORAGE_DRIVER",
        "s3",
        ["S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
    ),
    (AI_SERVICE, "LLM_PROVIDER", "gemini", ["GEMINI_API_KEY"]),
]

# Stand-ins for values Render or the user supplies, shaped so the schemas accept them.
SAMPLE_VALUES = {
    "MONGODB_URI": "mongodb+srv://databridge-app:pw@cluster0.example.mongodb.net/databridge",
    "S3_ENDPOINT": "https://account-id.r2.cloudflarestorage.com",
    "BOOTSTRAP_ADMIN_EMAIL": "admin@example.com",
    "REGISTRATION_INVITE_CODES": "blueprint-check-invite",
    "GEMINI_API_KEY": "blueprint-check-gemini-key",
}
KEY_VALUE_URL = "redis://red-blueprint-check:6379"

ENTRY_KINDS = ("value", "generateValue", "fromService", "sync")


class BlueprintError(Exception):
    """One or more problems; each line names one."""


# ---------------------------------------------------------------- config schemas


def api_schema_keys() -> tuple[set[str], set[str]]:
    """(all keys, required keys) of the api's Zod envSchema.

    A key is optional when its expression has a default or is optional, or uses a helper that
    always has one (positiveInt, booleanFlag, commaList, optionalString, trustProxy).
    """
    source = API_CONFIG.read_text(encoding="utf-8")
    match = re.search(
        r"const envSchema = z\s*\.object\(\{\n(.*?)\n  \}\)\s*\.superRefine", source, re.S
    )
    if not match:
        raise BlueprintError(f"could not find envSchema in {API_CONFIG.relative_to(ROOT)}")
    chunks = re.split(r"^    ([A-Z][A-Z0-9_]*):", match.group(1), flags=re.M)[1:]
    optional_markers = (
        ".default(",
        ".optional()",
        "positiveInt(",
        "booleanFlag(",
        "commaList(",
        "optionalString(",
        "trustProxy",
    )
    keys: set[str] = set()
    required: set[str] = set()
    for key, expression in zip(chunks[::2], chunks[1::2], strict=True):
        keys.add(key)
        if not any(marker in expression for marker in optional_markers):
            required.add(key)
    return keys, required


def _field_has_default(value: ast.expr | None) -> bool:
    if value is None:
        return False
    if isinstance(value, ast.Call) and getattr(value.func, "id", None) == "Field":
        has_positional_default = bool(value.args) and not (
            isinstance(value.args[0], ast.Constant) and value.args[0].value is Ellipsis
        )
        return has_positional_default or any(
            kw.arg in {"default", "default_factory"} for kw in value.keywords
        )
    return True


def ai_schema_keys() -> tuple[set[str], set[str]]:
    """(all keys, required keys) of the ai-service's Settings class (pydantic-settings)."""
    tree = ast.parse(AI_CONFIG.read_text(encoding="utf-8"))
    settings = next(
        (n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Settings"), None
    )
    if settings is None:
        raise BlueprintError(f"could not find class Settings in {AI_CONFIG.relative_to(ROOT)}")
    keys: set[str] = set()
    required: set[str] = set()
    for node in settings.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            key = node.target.id.upper()
            if key == "MODEL_CONFIG":
                continue
            keys.add(key)
            if not _field_has_default(node.value):
                required.add(key)
    return keys, required


def schemas() -> dict[str, tuple[set[str], set[str]]]:
    result = {API_SERVICE: api_schema_keys(), AI_SERVICE: ai_schema_keys()}
    # Guard against a parser that silently finds nothing after a refactor.
    for name, core in (
        (API_SERVICE, {"MONGODB_URI", "REDIS_URL", "JWT_ACCESS_SECRET", "AI_SERVICE_URL"}),
        (AI_SERVICE, {"MONGODB_URI", "REDIS_URL", "AI_SERVICE_TOKEN"}),
    ):
        missing = core - result[name][1]
        if missing:
            raise BlueprintError(
                f"{name}: schema parser did not find required keys {sorted(missing)}; "
                "update infra/render/check_blueprint.py"
            )
    return result


# ---------------------------------------------------------------- blueprint


def load_blueprint() -> dict[str, Any]:
    with BLUEPRINT.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("services"), list):
        raise BlueprintError("render.yaml: expected a mapping with a 'services' list")
    return data


def entry_kind(entry: dict[str, Any]) -> str | None:
    kinds = [k for k in ENTRY_KINDS if k in entry]
    if len(kinds) != 1:
        return None
    if kinds[0] == "sync" and entry["sync"] is not False:
        return None
    if kinds[0] == "generateValue" and entry["generateValue"] is not True:
        return None
    return kinds[0]


def service_env(data: dict[str, Any], service: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """key -> entry for one service, with linked groups expanded. Raises on duplicates."""
    groups = {g["name"]: g for g in data.get("envVarGroups", [])}
    env: dict[str, dict[str, Any]] = {}
    problems: list[str] = []

    def add(key: str, entry: dict[str, Any], where: str) -> None:
        if key in env:
            problems.append(f"{service['name']}: {key} is set twice ({where})")
        env[key] = entry

    for entry in service.get("envVars", []):
        if "fromGroup" in entry:
            group = groups.get(entry["fromGroup"])
            if group is None:
                problems.append(f"{service['name']}: unknown env group {entry['fromGroup']}")
                continue
            for group_entry in group.get("envVars", []):
                add(group_entry["key"], group_entry, f"group {group['name']}")
        else:
            add(str(entry.get("key")), entry, "envVars")
    if problems:
        raise BlueprintError("\n".join(problems))
    return env


def check_structure(data: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    services = {s.get("name"): s for s in data["services"]}
    for group in data.get("envVarGroups", []):
        for entry in group.get("envVars", []):
            if entry_kind(entry) not in {"value", "generateValue"}:
                problems.append(
                    f"group {group['name']}: {entry.get('key')} must use value or generateValue"
                )
    for service in data["services"]:
        name = service.get("name")
        if service.get("plan") != "free":
            problems.append(f"{name}: plan must be free")
        if service.get("region") != REGION:
            problems.append(f"{name}: region must be {REGION}")
        if service.get("type") == "keyvalue":
            if "ipAllowList" not in service:
                problems.append(f"{name}: ipAllowList is required for Key Value")
            continue
        if service.get("type") != "web" or service.get("runtime") != "docker":
            problems.append(f"{name}: expected type web with runtime docker")
        dockerfile = ROOT / str(service.get("dockerfilePath", ""))
        if not dockerfile.is_file():
            problems.append(f"{name}: dockerfilePath {service.get('dockerfilePath')} not found")
        if not str(service.get("healthCheckPath", "")).startswith("/"):
            problems.append(f"{name}: healthCheckPath is required")
        for entry in service.get("envVars", []):
            if "fromGroup" in entry:
                continue
            kind = entry_kind(entry)
            if kind is None:
                problems.append(
                    f"{name}: {entry.get('key')} needs exactly one of value, "
                    "generateValue: true, fromService or sync: false"
                )
            elif kind == "fromService":
                ref = entry["fromService"]
                target = services.get(ref.get("name"))
                if target is None or target.get("type") != ref.get("type"):
                    problems.append(f"{name}: {entry['key']} references unknown service {ref}")
                elif "envVarKey" in ref:
                    target_keys = {e.get("key") for e in target.get("envVars", [])}
                    if ref["envVarKey"] not in target_keys:
                        problems.append(
                            f"{name}: {entry['key']} copies {ref['envVarKey']}, "
                            f"which {ref['name']} does not define"
                        )
                elif ref.get("property") not in {"connectionString", "host", "port", "hostport"}:
                    problems.append(f"{name}: {entry['key']} needs property or envVarKey")
    return problems


def check_env(data: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    services = {s["name"]: s for s in data["services"]}
    for name, (known, required) in schemas().items():
        service = services.get(name)
        if service is None:
            problems.append(f"render.yaml: service {name} is missing")
            continue
        env = service_env(data, service)
        values = {k: str(e["value"]) for k, e in env.items() if "value" in e}
        needed = set(required) - PLATFORM_KEYS
        for cond_service, key, value, keys in CONDITIONAL:
            if cond_service == name and values.get(key) == value:
                needed.update(keys)
        for key in sorted(needed - env.keys()):
            problems.append(f"{name}: required variable {key} is missing")
        for key in sorted(env.keys() - known):
            problems.append(f"{name}: {key} is not read by this service (typo?)")
        for key in sorted(env.keys() & PLATFORM_KEYS):
            problems.append(f"{name}: {key} is set by Render; remove it")
    return problems


def resolved_env(data: dict[str, Any], name: str) -> dict[str, str]:
    """A service's environment with stand-ins for generated, linked and user-supplied values."""
    services = {s["name"]: s for s in data["services"]}
    generated: dict[tuple[str, str], str] = {}

    def resolve(service_name: str, key: str, entry: dict[str, Any]) -> str:
        if "value" in entry:
            return str(entry["value"])
        if entry.get("generateValue") is True:
            return generated.setdefault((service_name, key), secrets.token_urlsafe(33))
        if "fromService" in entry:
            ref = entry["fromService"]
            if ref.get("type") == "keyvalue":
                return KEY_VALUE_URL
            source = services[ref["name"]]
            source_entry = service_env(data, source)[ref["envVarKey"]]
            return resolve(source["name"], ref["envVarKey"], source_entry)
        return SAMPLE_VALUES.get(key, "blueprint-check-value")

    env = service_env(data, services[name])
    return {key: resolve(name, key, entry) for key, entry in env.items()}


def check_ai_settings(data: dict[str, Any]) -> list[str]:
    """Validate the ai-service's real Settings with the Blueprint's values."""
    sys.path.insert(0, str(AI_CONFIG.parents[1]))
    from pydantic import ValidationError

    from app.config import Settings

    try:
        Settings(
            _env_file=None, **{k.lower(): v for k, v in resolved_env(data, AI_SERVICE).items()}
        )
    except ValidationError as error:
        return [f"{AI_SERVICE}: settings do not validate:\n{error}"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--emit-env", metavar="SERVICE", help="print a service's env as JSON")
    args = parser.parse_args()
    try:
        data = load_blueprint()
        if args.emit_env:
            print(json.dumps(resolved_env(data, args.emit_env), indent=2, sort_keys=True))
            return 0
        problems = check_structure(data)
        if not problems:
            problems = check_env(data)
        if not problems:
            problems = check_ai_settings(data)
    except BlueprintError as error:
        problems = [str(error)]
    if problems:
        print("render.yaml check failed:", *problems, sep="\n  - ", file=sys.stderr)
        return 1
    print("render.yaml: OK (structure, required variables, ai-service settings)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
