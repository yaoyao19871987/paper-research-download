import json
import os
import sys

PUBLIC_DIR = r"D:\Code\public"
if PUBLIC_DIR not in sys.path:
    sys.path.insert(0, PUBLIC_DIR)

from kimi_shared.vault import SharedSecureVault  # type: ignore


VAULT_NAME = "sixue_credentials"
SECRETS_DIR = os.path.join(PUBLIC_DIR, "secrets")
KEYS_DIR = os.path.join(PUBLIC_DIR, "keys")


def _vault() -> SharedSecureVault:
    return SharedSecureVault(VAULT_NAME, secrets_dir=SECRETS_DIR, keys_dir=KEYS_DIR)


def _normalize_payload(payload: dict) -> dict:
    return {
        "username": str(payload.get("username", "") or "").strip(),
        "password": str(payload.get("password", "") or "").strip(),
    }


def main() -> None:
    action = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    vault = _vault()

    if action == "load":
        secret = vault.load()
        if not secret:
            print("{}")
            return
        payload = json.loads(secret)
        print(json.dumps(_normalize_payload(payload), ensure_ascii=False))
        return

    if action == "save":
        raw = sys.stdin.read()
        payload = _normalize_payload(json.loads(raw or "{}"))
        if not payload["username"] or not payload["password"]:
            raise RuntimeError("Both username and password are required to save credentials.")
        vault.encrypt_and_save(json.dumps(payload, ensure_ascii=False))
        print('{"saved": true}')
        return

    if action == "exists":
        print(json.dumps({"exists": vault.load() is not None}))
        return

    raise RuntimeError(f"Unsupported vault action: {action or '(empty)'}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise
