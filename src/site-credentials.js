const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const VAULT_HELPER = path.resolve(__dirname, "site-credential-vault.py");

function normalizeCredential(value) {
  return String(value || "").trim();
}

function runVault(action, input = "") {
  const result = spawnSync("python", [VAULT_HELPER, action], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1"
    },
    input,
    encoding: "utf8",
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Vault helper failed with code ${result.status}`).trim());
  }
  return String(result.stdout || "").trim();
}

function loadEncryptedCredentials() {
  try {
    const output = runVault("load");
    const parsed = output ? JSON.parse(output) : {};
    return {
      username: normalizeCredential(parsed.username),
      password: normalizeCredential(parsed.password)
    };
  } catch {
    return {
      username: "",
      password: ""
    };
  }
}

function saveEncryptedCredentials(username, password) {
  const payload = {
    username: normalizeCredential(username),
    password: normalizeCredential(password)
  };
  if (!payload.username || !payload.password) {
    return false;
  }
  runVault("save", JSON.stringify(payload));
  return true;
}

function resolveSiteCredentials(options = {}) {
  const explicitUsername = normalizeCredential(options.username);
  const explicitPassword = normalizeCredential(options.password);
  if (explicitUsername && explicitPassword) {
    try {
      saveEncryptedCredentials(explicitUsername, explicitPassword);
    } catch {
      // Keep going with explicit credentials even if vault persistence fails.
    }
    return {
      username: explicitUsername,
      password: explicitPassword,
      source: "explicit"
    };
  }

  const vaulted = loadEncryptedCredentials();
  if (vaulted.username && vaulted.password) {
    return {
      ...vaulted,
      source: "vault"
    };
  }

  const envUsername = normalizeCredential(process.env.USERNAME);
  const envPassword = normalizeCredential(process.env.PASSWORD);
  if (envUsername && envPassword) {
    try {
      saveEncryptedCredentials(envUsername, envPassword);
    } catch {
      // Environment values are still usable for the current run.
    }
    return {
      username: envUsername,
      password: envPassword,
      source: "env"
    };
  }

  return {
    username: explicitUsername || envUsername || vaulted.username,
    password: explicitPassword || envPassword || vaulted.password,
    source: "missing"
  };
}

module.exports = {
  loadEncryptedCredentials,
  resolveSiteCredentials,
  saveEncryptedCredentials
};
