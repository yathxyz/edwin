//! Opening a file or URL in the desktop's own application (references, mail parts): `xdg-open TARGET`, found on
//! PATH, with an argv of exactly those two, never a shell.
//!
//! What it is handed decides what runs, so the target is checked first. A URL's scheme is one of http, https,
//! mailto and file; a mailto never names an attachment. A file (an absolute path or a file: URL) is opened by its
//! real path, which a symlink cannot change after the check and which never reads as an option. A .desktop file,
//! a file with an execute bit, and a script or program by its content (#!, ELF) are never opened; any other file
//! whose type is not on the allow-list below (documents, images, audio, video, plain text) opens only when the
//! caller says the user confirmed it.
//!
//! The opener outlives the call and the program, as the application it starts does: it is not one of proc.rs's
//! children (those are ended with the program). It runs in a session of its own with no terminal and nothing on
//! its standard input, output or error, and a thread of its own waits for it, so it is never left a zombie and
//! the loop never waits for it.

use std::ffi::OsString;
use std::io::Read;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The opener, looked up on PATH.
const OPENER: &str = "xdg-open";

/// Extensions (lower case) of the files that open without a confirmation.
#[rustfmt::skip]
const ALLOWED: &[&str] = &[
    // documents
    "pdf", "epub", "djvu", "djv", "ps", "eps", "odt", "ods", "odp", "odg", "doc", "docx", "xls",
    "xlsx", "ppt", "pptx", "rtf",
    // plain text
    "txt", "md", "org", "csv", "tsv", "tex", "bib", "log",
    // images
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif",
    // audio
    "mp3", "ogg", "oga", "opus", "flac", "wav", "m4a", "aac",
    // video
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "ogv",
];

/// Open TARGET with xdg-open. Err says why it was refused or could not start.
pub fn open(target: &str, confirmed: bool) -> Result<(), String> {
    open_with(OPENER, target, confirmed)
}

/// As open, with PROGRAM as the opener (the tests' fake).
pub fn open_with(program: &str, target: &str, confirmed: bool) -> Result<(), String> {
    launch(program, check(target, confirmed)?)
}

/// The argument the opener gets for TARGET, or why it is refused.
pub fn check(target: &str, confirmed: bool) -> Result<OsString, String> {
    if target.is_empty() {
        return Err("Nothing to open".into());
    }
    if target.chars().any(char::is_control) {
        return Err(format!("Not opened: {target:?} holds a control character"));
    }
    if target.starts_with('-') {
        return Err(format!("Not opened: {target} reads as an option"));
    }
    if target.starts_with('/') {
        return check_file(Path::new(target), confirmed);
    }
    let Some((scheme, rest)) = target.split_once(':').filter(|(s, _)| is_scheme(s)) else {
        return Err(format!(
            "Not opened: {target} is neither a URL nor an absolute file name"
        ));
    };
    if target.chars().any(char::is_whitespace) {
        return Err(format!("Not opened: the URL {target:?} holds a space"));
    }
    match scheme.to_ascii_lowercase().as_str() {
        "http" | "https" => Ok(target.into()),
        "mailto" => {
            // Some mail programs attach a local file that a mailto: URL names.
            let query = rest.split_once('?').map_or("", |(_, q)| q);
            let query = String::from_utf8_lossy(&decode(query.as_bytes())?).to_ascii_lowercase();
            if query.contains("attach") {
                return Err(format!("Not opened: {target} names an attachment"));
            }
            Ok(target.into())
        }
        "file" => check_file(&file_path(rest)?, confirmed),
        s => Err(format!(
            "Not opened: {s}: is not a scheme Edwin opens (http, https, mailto, file)"
        )),
    }
}

fn is_scheme(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next().is_some_and(|c| c.is_ascii_alphabetic())
        && cs.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// The file a file: URL's REST (what follows "file:") names: an absolute path, on this machine, with no query or
/// fragment.
fn file_path(rest: &str) -> Result<PathBuf, String> {
    if rest.contains(['?', '#']) {
        return Err("Not opened: a file: URL with a query or a fragment".into());
    }
    let path = match rest.strip_prefix("//") {
        Some(r) => {
            let (host, path) = r.split_at(r.find('/').unwrap_or(r.len()));
            if !(host.is_empty() || host.eq_ignore_ascii_case("localhost")) {
                return Err(format!(
                    "Not opened: a file: URL of another machine ({host})"
                ));
            }
            path
        }
        None => rest,
    };
    if !path.starts_with('/') {
        return Err("Not opened: a file: URL with no absolute path".into());
    }
    let bytes = decode(path.as_bytes())?;
    if bytes.contains(&0) {
        return Err("Not opened: a file name with a NUL".into());
    }
    Ok(PathBuf::from(OsString::from_vec(bytes)))
}

/// Percent-decoding.
fn decode(s: &[u8]) -> Result<Vec<u8>, String> {
    let hex = |b: u8| (b as char).to_digit(16);
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'%' {
            let (Some(h), Some(l)) = (
                s.get(i + 1).and_then(|&b| hex(b)),
                s.get(i + 2).and_then(|&b| hex(b)),
            ) else {
                return Err("Not opened: a broken %-escape".into());
            };
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    Ok(out)
}

/// The real path of the file at PATH, if it may be opened.
fn check_file(path: &Path, confirmed: bool) -> Result<OsString, String> {
    let shown = path.display();
    let real =
        std::fs::canonicalize(path).map_err(|e| format!("Not opened: {shown}: {}", os_msg(&e)))?;
    let meta =
        std::fs::metadata(&real).map_err(|e| format!("Not opened: {shown}: {}", os_msg(&e)))?;
    if !meta.is_file() {
        return Err(format!("Not opened: {shown} is not a file"));
    }
    let ext = real
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "desktop" {
        return Err(format!(
            "Not opened: {shown} is a .desktop file, which runs a program"
        ));
    }
    if meta.permissions().mode() & 0o111 != 0 {
        return Err(format!("Not opened: {shown} is executable"));
    }
    let mut head = [0u8; 4];
    let n = std::fs::File::open(&real)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| format!("Not opened: {shown}: {}", os_msg(&e)))?;
    if head[..n].starts_with(b"#!") || head[..n].starts_with(b"\x7fELF") {
        return Err(format!("Not opened: {shown} is a script or a program"));
    }
    if !confirmed && !ALLOWED.contains(&ext.as_str()) {
        return Err(format!(
            "Not opened: {shown} is not a document, image, audio, video or text file Edwin opens unasked"
        ));
    }
    Ok(real.into_os_string())
}

fn os_msg(e: &std::io::Error) -> String {
    let m = e.to_string();
    m.split(" (os error").next().unwrap_or(&m).to_string()
}

/// Start PROGRAM ARG, not waited for here.
fn launch(program: &str, arg: OsString) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.arg(arg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: only async-signal-safe calls (setsid, signal, close_range), as between fork and exec they must be.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Edwin ignores SIGPIPE, and an ignored signal stays ignored across exec.
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            if libc::close_range(3, u32::MAX, libc::CLOSE_RANGE_CLOEXEC as i32) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Cannot run {program}: {}", os_msg(&e)))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("edwin-open-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn write(p: &Path, text: &str, mode: u32) {
        std::fs::write(p, text).unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    /// A fake xdg-open in DIR that writes each of its arguments on a line of DIR/argv, then its pid to DIR/pid.
    fn fake(dir: &Path) -> String {
        let p = dir.join("xdg-open");
        let d = dir.display();
        write(
            &p,
            &format!("#!/bin/sh\nprintf '%s\\n' \"$0\" \"$@\" > {d}/argv.tmp\nmv {d}/argv.tmp {d}/argv\necho $$ > {d}/pid.tmp\nmv {d}/pid.tmp {d}/pid\n"),
            0o755,
        );
        p.display().to_string()
    }
    fn wait_for(p: &Path) -> String {
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            if let Ok(s) = std::fs::read_to_string(p) {
                return s;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("{} never appeared", p.display());
    }

    #[test]
    fn the_opener_gets_exactly_its_name_and_the_target() {
        let d = tmp("argv");
        let prog = fake(&d);
        let url = "https://example.org/a?b=$HOME;touch%20x&c=`id`";
        open_with(&prog, url, false).unwrap();
        assert_eq!(wait_for(&d.join("argv")), format!("{prog}\n{url}\n"));
        // the pid file is written last: once it is there, the opener has done; it is reaped, never a zombie
        let pid = wait_for(&d.join("pid"));
        let gone = Instant::now() + Duration::from_secs(10);
        while Path::new(&format!("/proc/{}", pid.trim())).exists() {
            assert!(Instant::now() < gone, "the opener was left a zombie");
            std::thread::sleep(Duration::from_millis(10));
        }
        // a file by its real path, through a symlink and a file: URL
        let pdf = d.join("a b.pdf");
        write(&pdf, "%PDF-1.4\n", 0o644);
        std::os::unix::fs::symlink(&pdf, d.join("link.pdf")).unwrap();
        for t in [
            format!("file://{}/link.pdf", d.display()),
            format!("file://localhost{}/a%20b.pdf", d.display()),
            format!("{}/link.pdf", d.display()),
            pdf.display().to_string(),
        ] {
            let _ = std::fs::remove_file(d.join("argv"));
            open_with(&prog, &t, false).unwrap();
            assert_eq!(
                wait_for(&d.join("argv")),
                format!("{prog}\n{}\n", pdf.display()),
                "{t}"
            );
        }
        assert_eq!(
            check("mailto:me@example.org?subject=hi", false).unwrap(),
            "mailto:me@example.org?subject=hi"
        );
        assert_eq!(
            check("HTTP://example.org", false).unwrap(),
            "HTTP://example.org"
        );
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn urls_outside_the_allow_list_and_options_are_refused() {
        for t in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,x",
            "ftp://example.org/",
            "smb://host/share",
            "-x",
            "--help",
            "https://example.org/a b",
            "https://example.org/\nb",
            "relative/file.pdf",
            "file.pdf",
            "",
            "mailto:a@b?attach=/home/u/.ssh/id_ed25519",
            "mailto:a@b?Attachment=x",
            "mailto:a@b?%61ttach=x",
            "file:///etc/passwd?x",
            "file:///etc/passwd#x",
            "file://otherhost/etc/passwd",
            "file:relative",
            "file:///a%zz",
            "file:///a%00b",
        ] {
            assert!(check(t, true).is_err(), "{t:?} was not refused");
        }
        let d = tmp("refused");
        let prog = fake(&d);
        assert!(open_with(&prog, "javascript:alert(1)", true).is_err());
        assert!(open_with(&prog, "-x", true).is_err());
        std::thread::sleep(Duration::from_millis(200));
        assert!(!d.join("argv").exists(), "a refused target ran the opener");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn programs_scripts_and_desktop_files_are_refused_even_when_confirmed() {
        let d = tmp("files");
        let desktop = d.join("x.desktop");
        write(
            &desktop,
            "[Desktop Entry]\nExec=sh -c 'touch /tmp/owned'\n",
            0o644,
        );
        let exec = d.join("doc.pdf");
        write(&exec, "%PDF-1.4\n", 0o744);
        let script = d.join("notes.txt");
        write(&script, "#!/bin/sh\ntouch /tmp/owned\n", 0o644);
        let sh = d.join("run.sh");
        write(&sh, "#!/bin/sh\necho\n", 0o644);
        let elf = d.join("photo.png");
        write(&elf, "\x7fELF\x02\x01", 0o644);
        let link = d.join("link.pdf");
        std::os::unix::fs::symlink(&desktop, &link).unwrap();
        for p in [&desktop, &exec, &script, &sh, &elf, &link] {
            for confirmed in [false, true] {
                let t = p.display().to_string();
                assert!(
                    check(&t, confirmed).is_err(),
                    "{t} (confirmed {confirmed}) was not refused"
                );
                assert!(
                    check(&format!("file://{t}"), confirmed).is_err(),
                    "file://{t} was not refused"
                );
            }
        }
        assert!(
            check(&d.display().to_string(), true).is_err(),
            "a directory"
        );
        assert!(
            check(&format!("{}/missing.pdf", d.display()), true).is_err(),
            "a missing file"
        );
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_type_off_the_allow_list_opens_only_when_confirmed() {
        let d = tmp("types");
        let html = d.join("page.HTML");
        write(&html, "<p>x</p>\n", 0o600);
        let t = html.display().to_string();
        assert!(check(&t, false).is_err());
        assert_eq!(check(&t, true).unwrap(), html.as_os_str());
        let none = d.join("README");
        write(&none, "text\n", 0o600);
        assert!(check(&none.display().to_string(), false).is_err());
        let pdf = d.join("Paper.PDF");
        write(&pdf, "%PDF-1.4\n", 0o600);
        assert_eq!(
            check(&pdf.display().to_string(), false).unwrap(),
            pdf.as_os_str()
        );
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn an_opener_that_is_not_there_is_said() {
        let e = open_with("edwin-no-such-opener", "https://example.org", false).unwrap_err();
        assert_eq!(
            e,
            "Cannot run edwin-no-such-opener: No such file or directory"
        );
    }
}
