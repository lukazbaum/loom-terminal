/// Reject env keys / values that could break downstream consumers
/// (the loom daemon's CBOR framing, shell-quoting in spawned commands,
/// etc.) or that would inject code into the spawned agent process.
/// POSIX env names are conventionally `[A-Za-z_][A-Za-z0-9_]*`; we
/// validate keys against that regex equivalent, denylist names whose
/// only practical use is code-injection, and forbid newline / NUL
/// bytes in values.
use std::collections::HashMap;

/// Env names that act as code-injection vectors for the spawned shell
/// or for the agent CLI. A per-pane env override has very few
/// legitimate reasons to set any of these — and the cost of refusing
/// them (users can still set them in their shell rc) is much lower
/// than the cost of a single poisoned workspace JSON quietly enabling
/// `DYLD_INSERT_LIBRARIES` for every spawned agent.
///
/// Note: PATH is intentionally NOT on this list. `LD_LIBRARY_PATH` /
/// `DYLD_LIBRARY_PATH` / `PYTHONPATH` etc. all are.
fn is_denylisted_env_key(k: &str) -> bool {
    // Prefix matches: every LD_* / DYLD_* variant.
    if k.starts_with("LD_") || k.starts_with("DYLD_") {
        return true;
    }
    // Exact-name denylist. Kept short and case-sensitive (POSIX env
    // keys are case-sensitive; the upstream key validator already
    // enforces ASCII).
    matches!(
        k,
        "NODE_OPTIONS"
            | "BASH_ENV"
            | "ENV"
            | "PROMPT_COMMAND"
            | "IFS"
            | "PS4"
            | "PERL5LIB"
            | "PERL5OPT"
            | "PYTHONPATH"
            | "PYTHONSTARTUP"
            | "RUBYOPT"
            | "RUBYLIB"
            | "GIT_CONFIG"
            | "GIT_CONFIG_GLOBAL"
            | "GIT_EXEC_PATH"
    )
}

fn validate_env_pair(k: &str, v: &str) -> Result<(), String> {
    if k.is_empty() {
        return Err("env key must not be empty".into());
    }
    let mut chars = k.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(format!(
            "env key '{k}' must start with a letter or underscore"
        ));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!(
                "env key '{k}' contains an invalid character ('{c}')"
            ));
        }
    }
    if k.len() > 256 {
        return Err(format!("env key '{k}' is too long (>256 chars)"));
    }
    if is_denylisted_env_key(k) {
        return Err(format!(
            "env key '{k}' is denylisted — these names act as code-injection vectors for the spawned shell or agent; set them in your shell rc if you really need them"
        ));
    }
    for c in v.chars() {
        if c == '\0' {
            return Err(format!("env value for '{k}' contains a NUL byte"));
        }
        if c == '\n' || c == '\r' {
            return Err(format!(
                "env value for '{k}' contains a newline — pass multi-line values through a file path instead"
            ));
        }
    }
    if v.len() > 32_768 {
        return Err(format!("env value for '{k}' is too long (>32 KB)"));
    }
    Ok(())
}

pub(crate) fn validate_env_map(env: &HashMap<String, String>) -> Result<(), String> {
    for (k, v) in env {
        validate_env_pair(k, v)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(k: &str, v: &str) -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert(k.to_string(), v.to_string());
        m
    }

    #[test]
    fn rejects_ld_preload() {
        let err = validate_env_map(&one("LD_PRELOAD", "/tmp/evil.so"))
            .expect_err("LD_PRELOAD must be denylisted");
        assert!(err.contains("denylisted"));
    }

    #[test]
    fn rejects_dyld_insert_libraries() {
        assert!(validate_env_map(&one("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib")).is_err());
    }

    #[test]
    fn rejects_every_ld_prefix_variant() {
        for k in [
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "LD_AUDIT",
            "LD_BIND_NOW",
            "LD_DEBUG",
        ] {
            assert!(
                validate_env_map(&one(k, "x")).is_err(),
                "{k} must be denylisted"
            );
        }
    }

    #[test]
    fn rejects_every_dyld_prefix_variant() {
        for k in [
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "DYLD_FALLBACK_LIBRARY_PATH",
            "DYLD_FORCE_FLAT_NAMESPACE",
        ] {
            assert!(
                validate_env_map(&one(k, "x")).is_err(),
                "{k} must be denylisted"
            );
        }
    }

    #[test]
    fn rejects_node_options_python_perl_ruby_bash_env() {
        for k in [
            "NODE_OPTIONS",
            "BASH_ENV",
            "ENV",
            "PROMPT_COMMAND",
            "IFS",
            "PS4",
            "PERL5LIB",
            "PERL5OPT",
            "PYTHONPATH",
            "PYTHONSTARTUP",
            "RUBYOPT",
            "RUBYLIB",
            "GIT_CONFIG",
            "GIT_CONFIG_GLOBAL",
            "GIT_EXEC_PATH",
        ] {
            assert!(
                validate_env_map(&one(k, "x")).is_err(),
                "{k} must be denylisted"
            );
        }
    }

    #[test]
    fn accepts_path_and_normal_env() {
        // PATH is intentionally NOT denylisted — users routinely set it
        // per-pane to bring in homebrew / volta / etc.
        assert!(validate_env_map(&one("PATH", "/usr/local/bin:/usr/bin")).is_ok());
        assert!(validate_env_map(&one("CLAUDE_API_KEY", "sk-xxx")).is_ok());
        assert!(validate_env_map(&one("MY_VAR", "value")).is_ok());
    }

    #[test]
    fn denylist_is_case_sensitive() {
        // POSIX env names are case-sensitive. `ld_preload` lowercase is
        // a different variable that won't be honored by ld.so — let it
        // through so we don't surprise a user who legitimately picked a
        // lowercase name.
        assert!(validate_env_map(&one("ld_preload", "x")).is_ok());
    }
}
