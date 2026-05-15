use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

static CLAUDE_BIN: OnceLock<String> = OnceLock::new();

pub fn claude_bin() -> String {
    CLAUDE_BIN.get_or_init(resolve_claude_bin).clone()
}

fn resolve_claude_bin() -> String {
    if let Some(p) = find_in_path("claude") {
        return p;
    }

    if let Some(p) = resolve_via_login_shell() {
        return p;
    }

    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        let candidates = [
            home.join(".claude/local/claude"),
            home.join(".npm-global/bin/claude"),
            home.join(".bun/bin/claude"),
            home.join(".volta/bin/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ];
        for c in candidates.iter() {
            if c.exists() {
                return c.to_string_lossy().into_owned();
            }
        }
    }

    "claude".to_string()
}

fn find_in_path(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn resolve_via_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // `-lc` (login, NOT interactive). The interactive `-i` flag we used
    // to pass made zsh/bash source `.zshrc`/`.bashrc` on every cold
    // start, which is the standard "rc-corruption persistence" vector:
    // a prior agent session that wrote a malicious alias/function to
    // the rc file would silently execute it off-screen with no
    // attached terminal to surface the output. `.zprofile` /
    // `.bash_profile` (sourced by `-l` alone) is enough for PATH
    // overrides on a normal shell setup.
    let output = Command::new(&shell)
        .arg("-lc")
        .arg("command -v claude")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}
