/// Per-agent consent for the hook installers in `hook`, `hook_codex`,
/// `hook_gemini`. Stored in `~/.loom/hooks.json` so consent survives
/// localStorage clears and can be read from `setup()` before the webview
/// mounts.
///
/// State machine per agent:
/// - `Unset`   — never asked. Welcome will surface a card if the agent
///   appears to be installed (its config dir exists).
/// - `Enabled` — user opted in. We re-run `configure_*` on every launch
///   so script-bundle upgrades land transparently.
/// - `Declined`— user explicitly skipped. We don't install or re-prompt.
///
/// On first run after this module landed, `migrate_implicit_consent`
/// scans each agent's config for an existing Loom marker. If we wrote a
/// hook before consent was tracked, we treat that as implicit consent so
/// existing users aren't re-prompted (and their installed hooks keep
/// receiving upgrades).
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::atomic_write;

#[derive(Copy, Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentConsent {
    #[default]
    Unset,
    Enabled,
    Declined,
}

#[derive(Copy, Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Gemini,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ConsentFile {
    #[serde(default)]
    pub claude: AgentConsent,
    #[serde(default)]
    pub codex: AgentConsent,
    #[serde(default)]
    pub gemini: AgentConsent,
}

impl ConsentFile {
    pub fn get(&self, agent: AgentKind) -> AgentConsent {
        match agent {
            AgentKind::Claude => self.claude,
            AgentKind::Codex => self.codex,
            AgentKind::Gemini => self.gemini,
        }
    }

    pub fn set(&mut self, agent: AgentKind, value: AgentConsent) {
        match agent {
            AgentKind::Claude => self.claude = value,
            AgentKind::Codex => self.codex = value,
            AgentKind::Gemini => self.gemini = value,
        }
    }
}

fn home() -> Result<PathBuf, String> {
    let h = std::env::var("HOME").map_err(|e| format!("HOME not set: {e}"))?;
    Ok(PathBuf::from(h))
}

fn consent_path() -> Result<PathBuf, String> {
    Ok(home()?.join(".loom").join("hooks.json"))
}

pub fn load() -> ConsentFile {
    let Ok(path) = consent_path() else {
        return ConsentFile::default();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return ConsentFile::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save(consent: &ConsentFile) -> Result<(), String> {
    let path = consent_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let bytes =
        serde_json::to_vec_pretty(consent).map_err(|e| format!("serialize consent: {e}"))?;
    atomic_write::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn agent_dir(agent: AgentKind) -> Result<PathBuf, String> {
    let leaf = match agent {
        AgentKind::Claude => ".claude",
        AgentKind::Codex => ".codex",
        AgentKind::Gemini => ".gemini",
    };
    Ok(home()?.join(leaf))
}

pub fn agent_installed(agent: AgentKind) -> bool {
    agent_dir(agent).map(|p| p.is_dir()).unwrap_or(false)
}

/// True if the agent's config already contains a Loom marker — meaning we
/// (or an older version of Loom) wrote a hook there at some point.
pub fn agent_has_existing_loom_hook(agent: AgentKind) -> bool {
    let Ok(h) = home() else {
        return false;
    };
    agent_has_existing_loom_hook_at(&h, agent)
}

/// Same as `agent_has_existing_loom_hook` but with an explicit home
/// directory, so tests can point at a tempdir without racing $HOME with
/// cargo's parallel test runner.
///
/// Matches the exact form `hook_common` writes (` # <marker>` as a
/// trailing shell-comment) rather than raw substring presence. A naked
/// `content.contains(marker)` would otherwise treat a user command that
/// happens to mention the marker text — `STAGE=loom-stop-osc ...` — as
/// a Loom-managed entry, exactly the hijack class `is_loom_owned` was
/// tightened to reject.
pub fn agent_has_existing_loom_hook_at(home: &std::path::Path, agent: AgentKind) -> bool {
    let leaf = match agent {
        AgentKind::Claude => ".claude",
        AgentKind::Codex => ".codex",
        AgentKind::Gemini => ".gemini",
    };
    let dir = home.join(leaf);
    let (file, markers): (PathBuf, &[&str]) = match agent {
        // legacy marker covers users who accepted the very first Welcome flow
        AgentKind::Claude => (
            dir.join("settings.json"),
            &["loom-stop-osc", "loom-notify-hook"],
        ),
        AgentKind::Codex => (dir.join("hooks.json"), &["loom-codex-stop-osc"]),
        AgentKind::Gemini => (dir.join("settings.json"), &["loom-gemini-session-osc"]),
    };
    let Ok(content) = std::fs::read_to_string(&file) else {
        return false;
    };
    markers.iter().any(|m| content.contains(&format!(" # {m}")))
}

#[cfg(test)]
mod existing_hook_tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_claude_settings(home: &std::path::Path, body: &str) {
        let dir = home.join(".claude");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings.json"), body).unwrap();
    }

    #[test]
    fn detects_marker_as_trailing_shell_comment() {
        let home = TempDir::new().unwrap();
        let body = r#"{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "/x/loom-stop-hook.sh # loom-stop-osc"}]
    }]
  }
}"#;
        write_claude_settings(home.path(), body);
        assert!(agent_has_existing_loom_hook_at(
            home.path(),
            AgentKind::Claude
        ));
    }

    #[test]
    fn detects_legacy_marker_form() {
        let home = TempDir::new().unwrap();
        let body = r#"{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "/x/loom.sh # loom-notify-hook"}]
    }]
  }
}"#;
        write_claude_settings(home.path(), body);
        assert!(agent_has_existing_loom_hook_at(
            home.path(),
            AgentKind::Claude
        ));
    }

    #[test]
    fn does_not_match_user_command_that_mentions_marker_internally() {
        // A user hook with the marker as an env var / log message
        // substring — exactly the hijack-class the `is_loom_owned`
        // tightening rejected. The migrator must not auto-opt-in here.
        let home = TempDir::new().unwrap();
        let body = r#"{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "env STAGE=loom-stop-osc /usr/bin/true"}]
    }]
  }
}"#;
        write_claude_settings(home.path(), body);
        assert!(!agent_has_existing_loom_hook_at(
            home.path(),
            AgentKind::Claude
        ));
    }

    #[test]
    fn missing_settings_file_returns_false() {
        let home = TempDir::new().unwrap();
        assert!(!agent_has_existing_loom_hook_at(
            home.path(),
            AgentKind::Claude
        ));
    }

    #[test]
    fn codex_hooks_json_marker_is_detected() {
        let home = TempDir::new().unwrap();
        let dir = home.path().join(".codex");
        fs::create_dir_all(&dir).unwrap();
        let body = r#"{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "/x/loom.sh # loom-codex-stop-osc"}]
    }]
  }
}"#;
        fs::write(dir.join("hooks.json"), body).unwrap();
        assert!(agent_has_existing_loom_hook_at(
            home.path(),
            AgentKind::Codex
        ));
    }
}

/// If the consent file doesn't exist yet but the agent's config already
/// has a Loom marker, treat the existing install as implicit consent.
/// Runs once per launch; cheap (a few `read_to_string` calls).
pub fn migrate_implicit_consent() -> ConsentFile {
    let path = consent_path().ok();
    let file_exists = path.as_deref().is_some_and(std::path::Path::exists);
    let mut consent = load();
    if file_exists {
        return consent;
    }
    let mut changed = false;
    for agent in [AgentKind::Claude, AgentKind::Codex, AgentKind::Gemini] {
        if consent.get(agent) == AgentConsent::Unset && agent_has_existing_loom_hook(agent) {
            consent.set(agent, AgentConsent::Enabled);
            changed = true;
        }
    }
    if changed {
        if let Err(e) = save(&consent) {
            log::warn!("could not persist migrated consent: {e}");
        }
    }
    consent
}

#[derive(Clone, Serialize)]
pub struct AgentStatus {
    pub agent: &'static str,
    pub consent: AgentConsent,
    pub installed: bool,
    #[serde(rename = "hasExistingHook")]
    pub has_existing_hook: bool,
}

#[derive(Clone, Serialize)]
pub struct ConsentStatus {
    pub claude: AgentStatus,
    pub codex: AgentStatus,
    pub gemini: AgentStatus,
}

fn status_for(consent: &ConsentFile, agent: AgentKind, name: &'static str) -> AgentStatus {
    AgentStatus {
        agent: name,
        consent: consent.get(agent),
        installed: agent_installed(agent),
        has_existing_hook: agent_has_existing_loom_hook(agent),
    }
}

#[tauri::command]
pub fn hook_consent_status() -> ConsentStatus {
    let consent = load();
    ConsentStatus {
        claude: status_for(&consent, AgentKind::Claude, "claude"),
        codex: status_for(&consent, AgentKind::Codex, "codex"),
        gemini: status_for(&consent, AgentKind::Gemini, "gemini"),
    }
}

#[tauri::command]
pub fn hook_consent_set(agent: AgentKind, value: AgentConsent) -> Result<(), String> {
    let mut consent = load();
    consent.set(agent, value);
    save(&consent)
}
