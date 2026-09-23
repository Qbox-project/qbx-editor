use std::fs;
use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

const REPO: &str = "Qbox-project/qbx-lua-ls";
const SERVER: &str = "qbx-lua-ls";

struct QbxLuaExtension {
    cached_binary_path: Option<String>,
}

impl QbxLuaExtension {
    fn server_path(&mut self, id: &LanguageServerId, worktree: &zed::Worktree) -> Result<String> {
        let configured = LspSettings::for_worktree(SERVER, worktree)
            .ok()
            .and_then(|settings| settings.binary)
            .and_then(|binary| binary.path);
        if let Some(path) = configured.or_else(|| worktree.which(SERVER)) {
            return Ok(path);
        }
        if let Some(path) = &self.cached_binary_path {
            if fs::metadata(path).is_ok_and(|stat| stat.is_file()) {
                return Ok(path.clone());
            }
        }

        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let release = zed::latest_github_release(
            REPO,
            zed::GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        )?;

        let (os, arch) = zed::current_platform();
        let target = match (&os, &arch) {
            (zed::Os::Windows, zed::Architecture::X8664) => "x86_64-pc-windows-msvc",
            (zed::Os::Mac, zed::Architecture::Aarch64) => "aarch64-apple-darwin",
            (zed::Os::Mac, zed::Architecture::X8664) => "x86_64-apple-darwin",
            (zed::Os::Linux, zed::Architecture::Aarch64) => "aarch64-unknown-linux-musl",
            (zed::Os::Linux, zed::Architecture::X8664) => "x86_64-unknown-linux-musl",
            _ => {
                return Err(format!(
                    "no prebuilt {SERVER} for this platform; install it on PATH"
                ))
            }
        };
        let (archive, file_type, exe) = match os {
            zed::Os::Windows => ("zip", zed::DownloadedFileType::Zip, ".exe"),
            _ => ("tar.gz", zed::DownloadedFileType::GzipTar, ""),
        };

        let asset_name = format!("{SERVER}-{target}.{archive}");
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == asset_name)
            .ok_or_else(|| format!("release {} has no asset {asset_name}", release.version))?;

        let version_dir = format!("{SERVER}-{}", release.version);
        let binary_path = format!("{version_dir}/{SERVER}{exe}");

        if !fs::metadata(&binary_path).is_ok_and(|stat| stat.is_file()) {
            zed::set_language_server_installation_status(
                id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            zed::download_file(&asset.download_url, &version_dir, file_type)
                .map_err(|e| format!("failed to download {asset_name}: {e}"))?;
            if !matches!(os, zed::Os::Windows) {
                zed::make_file_executable(&binary_path)?;
            }
            for entry in fs::read_dir(".").map_err(|e| e.to_string())?.flatten() {
                if entry.file_name().to_str() != Some(version_dir.as_str()) {
                    fs::remove_dir_all(entry.path()).ok();
                }
            }
        }

        self.cached_binary_path = Some(binary_path.clone());
        Ok(binary_path)
    }
}

impl zed::Extension for QbxLuaExtension {
    fn new() -> Self {
        Self {
            cached_binary_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let args = LspSettings::for_worktree(SERVER, worktree)
            .ok()
            .and_then(|settings| settings.binary)
            .and_then(|binary| binary.arguments)
            .unwrap_or_default();
        Ok(zed::Command {
            command: self.server_path(id, worktree)?,
            args,
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree(SERVER, worktree)
            .ok()
            .and_then(|settings| settings.initialization_options))
    }

    fn language_server_workspace_configuration(
        &mut self,
        _id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree(SERVER, worktree)
            .ok()
            .and_then(|settings| settings.settings))
    }
}

zed::register_extension!(QbxLuaExtension);
