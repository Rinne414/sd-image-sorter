//! SD Image Sorter.exe: the one file a user double-clicks.
//!
//! The desktop shell (Electron) and its ~20 support files live in the
//! `desktop` folder next to this program so the top of the package stays
//! tidy. This launcher starts `desktop\sd-image-sorter-shell.exe` with the
//! same arguments and working directory, then exits. No console window, no
//! PowerShell or cmd in between.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const SHELL_DIR: &str = "desktop";
const SHELL_EXE: &str = "sd-image-sorter-shell.exe";

/// `<folder of this program>\desktop\sd-image-sorter-shell.exe`.
fn shell_path(launcher: &Path) -> Option<PathBuf> {
    Some(launcher.parent()?.join(SHELL_DIR).join(SHELL_EXE))
}

/// Start the shell with the caller's arguments and working directory.
fn start(shell: &Path, args: impl IntoIterator<Item = OsString>) -> std::io::Result<()> {
    let mut command = Command::new(shell);
    command.args(args);
    if let Ok(cwd) = env::current_dir() {
        command.current_dir(cwd);
    }
    // The child is not waited for: the launcher ends and the shell goes on alone.
    command.spawn().map(drop)
}

#[cfg(windows)]
fn show_error(text: &str) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut (), text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    const MB_OK_ICONERROR: u32 = 0x10;
    let wide = |s: &str| -> Vec<u16> { std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect() };
    let (text, caption) = (wide(text), wide("SD Image Sorter"));
    // SAFETY: both buffers are NUL-terminated and outlive the call.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_OK_ICONERROR) };
}

#[cfg(not(windows))]
fn show_error(text: &str) {
    eprintln!("{text}");
}

fn main() -> ExitCode {
    let launched = env::current_exe().ok().and_then(|exe| shell_path(&exe));
    let Some(shell) = launched else {
        show_error("SD Image Sorter could not find its own folder.\n\n找不到 SD Image Sorter 自己所在的文件夹。");
        return ExitCode::FAILURE;
    };
    if !shell.is_file() {
        show_error(&format!(
            "SD Image Sorter cannot start: {0} is missing. Extract the whole package again and keep its folders together.\n\n无法启动 SD Image Sorter：缺少 {0}。请重新解压整个压缩包，并保持其中的文件夹完整。",
            shell.display()
        ));
        return ExitCode::FAILURE;
    }
    match start(&shell, env::args_os().skip(1)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            show_error(&format!(
                "SD Image Sorter could not start {0}: {error}\n\n无法启动 {0}：{error}",
                shell.display()
            ));
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shell_sits_in_the_desktop_folder_next_to_the_launcher() {
        let path = shell_path(Path::new(r"C:\Apps\SD Image Sorter v1\SD Image Sorter.exe")).unwrap();
        assert_eq!(path, Path::new(r"C:\Apps\SD Image Sorter v1").join("desktop").join(SHELL_EXE));
    }
}
