//! edwin in a pseudo-terminal: the Vim criteria (exit statuses, $EDITOR use), files as the disk has them,
//! the terminal's events, signals, the cold start beside the snapshot; edwin never attaching to edwind, and
//! edwinclient, which always does.
//!
//! Each test runs the binary on a pty in its own directory, answers the terminal queries as a terminal
//! would (DA1, background colour), types keys and waits for the exit status.

use std::ffi::CString;
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

mod common;
use common::{client, have_node, EdwindUp};

const BIN: &str = env!("CARGO_BIN_EXE_edwin");

struct Pty {
    fd: RawFd,
    pid: libc::pid_t,
    out: Vec<u8>,
    status: Option<i32>,
}

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap()
}

impl Pty {
    fn spawn(dir: &Path, args: &[&str], extra_env: &[(&str, &str)]) -> Pty {
        Pty::spawn_program(dir, BIN, args, extra_env)
    }
    fn spawn_program(dir: &Path, program: &str, args: &[&str], extra_env: &[(&str, &str)]) -> Pty {
        let mut env: Vec<(String, String)> = vec![
            ("HOME".into(), dir.display().to_string()),
            (
                "XDG_STATE_HOME".into(),
                dir.join("state").display().to_string(),
            ),
            (
                "XDG_CONFIG_HOME".into(),
                dir.join("config").display().to_string(),
            ),
            ("TERM".into(), "xterm-256color".into()),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
        ];
        for (k, v) in extra_env {
            env.retain(|(a, _)| a != k);
            if !v.is_empty() {
                env.push((k.to_string(), v.to_string()));
            }
        }
        let envp: Vec<CString> = env.iter().map(|(k, v)| cstr(&format!("{k}={v}"))).collect();
        let mut envp_ptrs: Vec<*const libc::c_char> = envp.iter().map(|c| c.as_ptr()).collect();
        envp_ptrs.push(std::ptr::null());
        let argv: Vec<CString> = std::iter::once(program)
            .chain(args.iter().copied())
            .map(cstr)
            .collect();
        let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|c| c.as_ptr()).collect();
        argv_ptrs.push(std::ptr::null());
        let bin = cstr(program);
        let cwd = cstr(&dir.display().to_string());
        let ws = libc::winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let mut fd: RawFd = -1;
        // SAFETY: the child only calls chdir and execve (async-signal-safe) with data prepared before fork.
        let pid = unsafe { libc::forkpty(&mut fd, std::ptr::null_mut(), std::ptr::null(), &ws) };
        assert!(pid >= 0, "forkpty failed");
        if pid == 0 {
            unsafe {
                libc::chdir(cwd.as_ptr());
                libc::execve(bin.as_ptr(), argv_ptrs.as_ptr(), envp_ptrs.as_ptr());
                libc::_exit(127);
            }
        }
        Pty {
            fd,
            pid,
            out: Vec::new(),
            status: None,
        }
    }
    /// Read what the program wrote for MS milliseconds, answering its terminal queries.
    fn pump(&mut self, ms: u64) {
        let end = Instant::now() + Duration::from_millis(ms);
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let mut p = libc::pollfd {
                fd: self.fd,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd.
            let n = unsafe { libc::poll(&mut p, 1, left.as_millis() as i32) };
            if n > 0 {
                let mut b = [0u8; 65536];
                // SAFETY: reading into a local buffer.
                let k =
                    unsafe { libc::read(self.fd, b.as_mut_ptr() as *mut libc::c_void, b.len()) };
                if k <= 0 {
                    self.reap(true);
                    return;
                }
                let chunk = &b[..k as usize];
                if contains(chunk, b"\x1b]11;?") {
                    self.send_raw(b"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\");
                }
                if contains(chunk, b"\x1b[c") {
                    self.send_raw(b"\x1b[?62;22c");
                }
                self.out.extend_from_slice(chunk);
            }
            if Instant::now() >= end {
                return;
            }
        }
    }
    /// Wait for the first complete draw.
    fn ready(&mut self) -> &mut Self {
        let end = Instant::now() + Duration::from_secs(10);
        while !contains(&self.out, b"\x1b[?2026l") {
            assert!(
                Instant::now() < end,
                "no first draw; output: {:?}",
                String::from_utf8_lossy(&self.out)
            );
            self.pump(20);
        }
        self
    }
    fn send_raw(&self, s: &[u8]) {
        // SAFETY: writing a local buffer to our pty.
        unsafe { libc::write(self.fd, s.as_ptr() as *const libc::c_void, s.len()) };
    }
    /// Type S, then let the program take it in.
    fn keys(&mut self, s: &str) -> &mut Self {
        self.send_raw(s.as_bytes());
        self.pump(60);
        self
    }
    /// ESC on its own: a lone ESC is told from a sequence by the pause after it.
    fn esc(&mut self) -> &mut Self {
        self.send_raw(b"\x1b");
        self.pump(120);
        self
    }
    fn reap(&mut self, block: bool) {
        if self.status.is_some() {
            return;
        }
        let mut st = 0;
        // SAFETY: waiting for our own child.
        let r = unsafe { libc::waitpid(self.pid, &mut st, if block { 0 } else { libc::WNOHANG }) };
        if r == self.pid {
            self.status = Some(if libc::WIFEXITED(st) {
                libc::WEXITSTATUS(st)
            } else {
                128 + libc::WTERMSIG(st)
            });
        }
    }
    /// The exit status, waiting up to five seconds.
    fn exit(&mut self) -> i32 {
        let end = Instant::now() + Duration::from_secs(5);
        while self.status.is_none() {
            self.reap(false);
            if self.status.is_some() {
                break;
            }
            assert!(
                Instant::now() < end,
                "edwin did not exit; screen tail: {:?}",
                tail(&self.out)
            );
            self.pump(20);
        }
        self.status.unwrap()
    }
    fn signal(&self, sig: libc::c_int) {
        // SAFETY: signalling our own child.
        unsafe { libc::kill(self.pid, sig) };
    }
    fn resize(&self, cols: u16, rows: u16) {
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: TIOCSWINSZ on our pty master.
        unsafe { libc::ioctl(self.fd, libc::TIOCSWINSZ, &ws) };
        self.signal(libc::SIGWINCH);
    }
    fn take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        if self.status.is_none() {
            self.signal(libc::SIGKILL);
            self.reap(true);
        }
        // SAFETY: closing our pty master.
        unsafe { libc::close(self.fd) };
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}
fn tail(b: &[u8]) -> String {
    String::from_utf8_lossy(&b[b.len().saturating_sub(400)..]).into_owned()
}

/// A fresh directory for one test.
fn workdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("edwin-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn read(p: impl AsRef<Path>) -> String {
    std::fs::read_to_string(p).unwrap()
}

#[test]
fn wq_saves_and_exits_zero() {
    let d = workdir("wq");
    std::fs::write(d.join("a.txt"), "hello\nworld\n").unwrap();
    let mut t = Pty::spawn(&d, &["a.txt"], &[]);
    t.ready().keys("Ofirst").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("a.txt")), "first\nhello\nworld\n");
}

#[test]
fn cq_exits_nonzero_and_saves_nothing() {
    let d = workdir("cq");
    std::fs::write(d.join("COMMIT_EDITMSG"), "msg\n").unwrap();
    let mut t = Pty::spawn(&d, &["COMMIT_EDITMSG"], &[]);
    t.ready().keys("dd:cq\r");
    assert_eq!(t.exit(), 1);
    assert_eq!(read(d.join("COMMIT_EDITMSG")), "msg\n");
    let mut t = Pty::spawn(&d, &["COMMIT_EDITMSG"], &[]);
    t.ready().keys(":cq 3\r");
    assert_eq!(t.exit(), 3);
}

#[test]
fn q_refuses_changes_until_bang() {
    let d = workdir("q");
    std::fs::write(d.join("b.txt"), "one\n").unwrap();
    let mut t = Pty::spawn(&d, &["b.txt"], &[]);
    t.ready().keys("x:q\r");
    t.pump(150);
    assert!(t.status.is_none(), ":q left with changes");
    assert!(contains(&t.out, b"E37"), "no E37 in {:?}", tail(&t.out));
    t.keys(":q!\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("b.txt")), "one\n");
}

#[test]
fn zz_and_c_x_c_c_save_then_leave() {
    let d = workdir("zz");
    std::fs::write(d.join("z.txt"), "z\n").unwrap();
    let mut t = Pty::spawn(&d, &["z.txt"], &[]);
    t.ready().keys("Atwo").esc().keys("ZZ");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("z.txt")), "ztwo\n");
    let mut t = Pty::spawn(&d, &["z.txt"], &[]);
    t.ready().keys("x\x18\x03");
    t.pump(100);
    t.keys("y");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("z.txt")).len(), 4);
}

#[test]
fn a_new_file_ends_in_a_newline() {
    let d = workdir("new");
    let mut t = Pty::spawn(&d, &["sub-new.txt"], &[]);
    t.ready();
    assert!(contains(&t.out, b"[New]"));
    t.keys("ihi").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("sub-new.txt")), "hi\n");
}

#[test]
fn files_keep_their_line_ends_mode_and_links() {
    use std::os::unix::fs::PermissionsExt;
    let d = workdir("shape");
    std::fs::write(d.join("dos.txt"), "\u{feff}one\r\ntwo\r\n").unwrap();
    std::fs::write(d.join("target.txt"), "t\n").unwrap();
    std::os::unix::fs::symlink("target.txt", d.join("link.txt")).unwrap();
    std::fs::set_permissions(d.join("target.txt"), std::fs::Permissions::from_mode(0o640)).unwrap();
    let mut t = Pty::spawn(&d, &["dos.txt"], &[]);
    t.ready()
        .keys("Ax")
        .esc()
        .keys(":w\r:e link.txt\r")
        .keys("Ay")
        .esc()
        .keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(
        std::fs::read(d.join("dos.txt")).unwrap(),
        "\u{feff}onex\r\ntwo\r\n".as_bytes()
    );
    assert!(
        std::fs::symlink_metadata(d.join("link.txt"))
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link was replaced by a file"
    );
    assert_eq!(read(d.join("target.txt")), "ty\n");
    assert_eq!(
        std::fs::metadata(d.join("target.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
}

/// Dired on the program's own files: the natives behind host.files.tree (lstat, rename, copyTree, removeDir).
#[test]
fn dired_lists_and_changes_the_programs_own_directories() {
    let d = workdir("dired");
    std::fs::create_dir_all(d.join("sub/deep")).unwrap();
    std::fs::write(d.join("a.txt"), "a\n").unwrap();
    std::fs::write(d.join("b.txt"), "one\r\ntwo\r\n").unwrap();
    std::fs::write(d.join("sub/in.txt"), "inside\n").unwrap();
    std::os::unix::fs::symlink("in.txt", d.join("sub/ln")).unwrap();
    let mut t = Pty::spawn(&d, &["b.txt"], &[]);
    t.ready();
    // SPC f d offers the working directory; the listing shows a name with its mode and size.
    t.keys(" fd");
    t.pump(200);
    t.keys("\r");
    t.pump(300);
    assert!(
        contains(&t.out, b"drwx") && contains(&t.out, b"-rw-"),
        "no listing in {:?}",
        tail(&t.out)
    );
    // Rename the open file: its buffer follows, and keeps its line ends.
    t.keys("/b.txt\r").keys("R");
    t.pump(200);
    t.keys("c.txt\r");
    t.pump(300);
    // Copy a directory with a link in it, make directories, delete a file and a directory with contents.
    t.keys("/sub\r").keys("C");
    t.pump(200);
    t.keys("copy\r");
    t.pump(300);
    t.keys("+");
    t.pump(200);
    t.keys("made/deeper\r");
    t.pump(300);
    t.keys("/a.txt\r").keys("D");
    t.pump(200);
    t.keys("y");
    t.pump(300);
    t.keys("/sub\r").keys("D");
    t.pump(200);
    t.keys("y");
    t.pump(200);
    t.keys("yes\r");
    t.pump(300);
    t.keys(":b c.txt\r").keys("Gothree").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert!(!d.join("b.txt").exists());
    assert_eq!(read(d.join("c.txt")), "one\r\ntwo\r\nthree\r\n");
    assert_eq!(read(d.join("copy/in.txt")), "inside\n");
    assert_eq!(
        std::fs::read_link(d.join("copy/ln")).unwrap(),
        Path::new("in.txt")
    );
    assert!(d.join("copy/deep").is_dir());
    assert!(d.join("made/deeper").is_dir());
    assert!(!d.join("a.txt").exists());
    assert!(!d.join("sub").exists());
}

#[test]
fn one_file_under_two_names_is_one_buffer() {
    let d = workdir("names");
    std::fs::write(d.join("real.txt"), "one\n").unwrap();
    std::os::unix::fs::symlink(d.join("real.txt"), d.join("alias.txt")).unwrap();
    let mut t = Pty::spawn(&d, &["real.txt"], &[]);
    t.ready();
    t.keys("Ax").esc();
    t.keys(":e ./alias.txt\r").keys("Ay").esc();
    t.keys(":e sub/../real.txt\r")
        .keys("Az")
        .esc()
        .keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("real.txt")), "onexyz\n");
    assert!(std::fs::symlink_metadata(d.join("alias.txt"))
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn a_file_that_is_not_text_is_refused() {
    let d = workdir("binary");
    std::fs::write(d.join("x.bin"), [0xffu8, 0xfe, 0x00, 0x80]).unwrap();
    let mut t = Pty::spawn(&d, &["x.bin"], &[]);
    t.ready();
    assert!(contains(&t.out, b"not UTF-8 text"), "{:?}", tail(&t.out));
    t.keys(":q\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(
        std::fs::read(d.join("x.bin")).unwrap(),
        [0xffu8, 0xfe, 0x00, 0x80]
    );
}

#[test]
fn plus_line_starts_on_that_line() {
    let d = workdir("args");
    std::fs::write(d.join("l.txt"), "1\n2\n3\n").unwrap();
    let mut t = Pty::spawn(&d, &["+2", "l.txt"], &[]);
    t.ready().keys("dd:wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("l.txt")), "1\n3\n");
}

#[test]
fn a_dash_edits_standard_input() {
    let d = workdir("stdin");
    let mut t = Pty::spawn_program(
        &d,
        "/bin/sh",
        &["-c", &format!("printf 'piped text\\n' | {BIN} -")],
        &[],
    );
    t.ready().keys(":w out.txt\r:q\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("out.txt")), "piped text\n");
}

#[test]
fn a_window_without_a_display_is_the_terminal() {
    let d = workdir("nodisplay");
    std::fs::write(d.join("a.txt"), "one\n").unwrap();
    let mut t = Pty::spawn(&d, &["--gui", "a.txt"], &[]);
    t.ready().keys("Atwo").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert!(
        contains(&t.out, b"cannot open a window: no display"),
        "{}",
        tail(&t.out)
    );
    assert_eq!(read(d.join("a.txt")), "onetwo\n");
    // With no terminal either (a new session has no controlling terminal) there is nothing to draw on.
    let mut cmd = std::process::Command::new(BIN);
    cmd.args(["--gui", "a.txt"])
        .current_dir(&d)
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY");
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut cmd, || {
            libc::setsid();
            Ok(())
        });
    }
    let o = cmd.output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).contains("cannot open a window: no display"));
}

#[test]
fn help_version_and_bad_options_need_no_terminal() {
    let o = std::process::Command::new(BIN)
        .arg("--help")
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(String::from_utf8_lossy(&o.stdout).starts_with("Usage: edwin"));
    let o = std::process::Command::new(BIN)
        .arg("--version")
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&o.stdout).starts_with("edwin "));
    let o = std::process::Command::new(BIN)
        .arg("--frobnicate")
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&o.stderr).contains("unknown option --frobnicate"));
    // edwin never attaches: edwinclient's options, and the removed --standalone, are unknown to it.
    for opt in ["--socket=/x", "--remote", "-a", "--standalone"] {
        let o = std::process::Command::new(BIN).arg(opt).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{opt}");
        let err = String::from_utf8_lossy(&o.stderr);
        assert!(
            err.contains(&format!(
                "unknown option {opt} (edwin never attaches to edwind; edwinclient does)"
            )),
            "{err}"
        );
    }
    let o = std::process::Command::new(BIN)
        .args(["-g", "--geometry=99999999999x1"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&o.stderr).contains("--geometry wants COLSxROWS"));
    // An argument that is not UTF-8 is a usage error, not a crash.
    let o = std::process::Command::new(BIN)
        .arg(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(b"\xff"))
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&o.stderr).contains("edwin: not UTF-8"));
    // edwinclient answers these with no edwind to attach to; -g is edwin's.
    let d = workdir("client-help");
    let c = client(&d);
    let o = std::process::Command::new(&c)
        .arg("--help")
        .env_remove("EDWIN_SOCKET")
        .env_remove("XDG_RUNTIME_DIR")
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(String::from_utf8_lossy(&o.stdout).starts_with("Usage: edwinclient"));
    for (args, said) in [
        (
            &["-g"][..],
            "edwinclient: unknown option -g (edwinclient --help lists them)",
        ),
        (&["-e"][..], "edwinclient: -e needs a form"),
        (&["a.txt", "-e"][..], "edwinclient: -e needs a form"),
        // main.rs reads --geometry as main.ts does: neither a sign nor a number past a u32.
        (
            &["--geometry=+5x5", "a.txt"][..],
            "edwinclient: --geometry wants COLSxROWS, not +5x5",
        ),
        (
            &["-c", "--geometry=99999999999x1", "a.txt"][..],
            "edwinclient: --geometry wants COLSxROWS, not 99999999999x1",
        ),
        (&["--socket"][..], "edwinclient: --socket needs a path"),
        (
            &["--socket=/a", "--remote", "h:/b"][..],
            "give one of them once",
        ),
    ] {
        let o = std::process::Command::new(&c)
            .args(args)
            .env_remove("EDWIN_SOCKET")
            .env_remove("XDG_RUNTIME_DIR")
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(
            String::from_utf8_lossy(&o.stderr).contains(said),
            "{args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
    }
}

#[test]
fn sigterm_rescues_changes_and_exits_143() {
    let d = workdir("term");
    std::fs::write(d.join("r.txt"), "r\n").unwrap();
    let mut t = Pty::spawn(&d, &["r.txt"], &[]);
    t.ready().keys("Arescued").esc();
    t.signal(libc::SIGTERM);
    assert_eq!(t.exit(), 143);
    assert_eq!(read(d.join("r.txt")), "r\n");
    let rescue: Vec<_> = std::fs::read_dir(d.join("state/edwin/rescue"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(rescue.len(), 1);
    assert_eq!(read(rescue[0].path()), "rrescued\n");
}

#[test]
fn terminal_events_clipboard_mouse_paste_resize_suspend() {
    let d = workdir("events");
    std::fs::write(d.join("m.txt"), "alpha beta\ngamma delta\n").unwrap();
    let mut t = Pty::spawn(&d, &["m.txt"], &[("COLORTERM", "truecolor")]);
    t.ready();
    assert!(
        contains(&t.out, b"\x1b[?1049h")
            && contains(&t.out, b"\x1b[?2004h")
            && contains(&t.out, b"\x1b[?1006h")
    );
    assert!(contains(&t.out, b"48;2;"), "truecolor backgrounds");
    t.take();
    t.keys("yy");
    assert!(
        contains(&t.out, b"\x1b]52;c;YWxwaGEgYmV0YQo="),
        "yy copies through OSC 52"
    );
    // Line numbers take the first cells: column 6 of row 2 is a few characters into "gamma delta".
    t.keys("\x1b[<0;9;2M\x1b[<0;9;2m");
    t.keys("\x1b[200~PASTE\x1b[201~");
    t.take();
    t.resize(100, 30);
    t.pump(200);
    assert!(
        contains(&t.out, b"\x1b[2J") && contains(&t.out, b"\x1b[30;1H"),
        "a resize draws the whole screen again"
    );
    t.take();
    t.keys("\x1a");
    t.pump(200);
    let out = t.take();
    let left = out
        .windows(8)
        .position(|w| w == b"\x1b[?1049l")
        .expect("C-z leaves the alternate screen");
    assert!(
        contains(&out[left..], b"\x1b[?1049h"),
        "and enters it again on resume"
    );
    t.keys(":wq\r");
    assert_eq!(t.exit(), 0);
    let text = read(d.join("m.txt"));
    assert!(
        text.starts_with("alpha beta\ng") && text.contains("PASTE") && text.ends_with("delta\n"),
        "{text:?}"
    );
}

#[test]
fn the_cold_start_works_as_the_snapshot_does() {
    let d = workdir("cold");
    std::fs::write(d.join("c.txt"), "cold\n").unwrap();
    let mut t = Pty::spawn(&d, &["c.txt"], &[("EDWIN_NO_SNAPSHOT", "1")]);
    t.ready().keys("Aer").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("c.txt")), "colder\n");
}

#[test]
fn the_user_init_runs_and_settings_persist() {
    let d = workdir("init");
    std::fs::create_dir_all(d.join("config/edwin")).unwrap();
    std::fs::write(
        d.join("config/edwin/init.scm"),
        "(define-key evil-normal-state-map \"Q\" 'evil-quit-all-with-error-code)\n",
    )
    .unwrap();
    std::fs::write(d.join("p.txt"), "a\nb\nc\nd\n").unwrap();
    let mut t = Pty::spawn(&d, &["p.txt"], &[]);
    t.ready().keys("jj:q\r");
    assert_eq!(t.exit(), 0);
    // save-place put point back on line 3; the init's Q leaves with status 1.
    let mut t = Pty::spawn(&d, &["p.txt"], &[]);
    t.ready().keys("dd:w\rQ");
    assert_eq!(t.exit(), 1);
    assert_eq!(read(d.join("p.txt")), "a\nb\nd\n");
}

/// edwin is the editor on its own, as emacs is: an edwind answering on $EDWIN_SOCKET and on the user's socket is
/// not asked, the note is the disk's file, and the user's own init.scm runs.
#[test]
fn edwin_never_attaches() {
    if !have_node() {
        return;
    }
    let up = EdwindUp::start();
    let d = workdir("never");
    std::fs::create_dir_all(d.join("run/edwin")).unwrap();
    std::os::unix::fs::symlink(&up.socket, d.join("run/edwin/edit.sock")).unwrap();
    std::fs::create_dir_all(d.join("config/edwin")).unwrap();
    std::fs::write(
        d.join("config/edwin/init.scm"),
        "(define-key evil-normal-state-map \"Q\" 'evil-quit-all-with-error-code)\n",
    )
    .unwrap();
    let b = Path::new(&up.notes).join("b.md");
    std::fs::write(&b, "b\n").unwrap();
    let run = d.join("run");
    let mut t = Pty::spawn(
        &d,
        &[b.to_str().unwrap()],
        &[
            ("EDWIN_SOCKET", &up.socket),
            ("XDG_RUNTIME_DIR", run.to_str().unwrap()),
        ],
    );
    t.ready().keys("Aedited").esc().keys(":w\rQ");
    assert_eq!(t.exit(), 1, "the user's init.scm did not bind Q");
    assert_eq!(read(&b), "bedited\n");
    // edwind opened only a.md, for the helper: nothing of edwin's.
    let after = up.finish();
    assert!(after.ends_with(r#""opened":["a.md"]}"#), "edwind: {after}");
}

/// edwinclient with no edwind to attach to says so on one line and exits 1, without taking the terminal or
/// editing on its own; -a without edwin-daemon beside the program says why it cannot start one.
#[test]
fn edwinclient_without_an_edwind_says_so_and_leaves_the_terminal_alone() {
    let d = workdir("no-edwind");
    let c = client(&d);
    let (run, missing) = (d.join("run"), d.join("missing.sock"));
    std::fs::create_dir_all(&run).unwrap();
    let env = [
        ("XDG_RUNTIME_DIR", run.to_str().unwrap()),
        ("EDWIN_SOCKET", missing.to_str().unwrap()),
    ];
    let mut t = Pty::spawn_program(&d, &c, &["a.txt"], &env);
    assert_eq!(t.exit(), 1);
    t.pump(200);
    let said = format!(
        "edwinclient: no edwind answers at {} or {}/edwin/edit.sock; start one with `edwin --daemon`, or give -a",
        missing.display(),
        run.display()
    );
    assert!(contains(&t.out, said.as_bytes()), "{:?}", tail(&t.out));
    assert!(!contains(&t.out, b"\x1b[?1049h"), "the terminal was taken");
    assert!(!d.join("a.txt").exists());
    // A socket that accepts but is no edwind (it closes each connection unanswered) does not answer either.
    let mute = d.join("mute.sock");
    let listener = std::os::unix::net::UnixListener::bind(&mute).unwrap();
    std::thread::spawn(move || listener.incoming().for_each(drop));
    let mute = mute.to_str().unwrap();
    for args in [&["--socket", mute, "a.txt"][..], &["--socket", mute, "-e", "1"]] {
        let mut t = Pty::spawn_program(&d, &c, args, &env);
        assert_eq!(t.exit(), 1, "{args:?}");
        t.pump(200);
        let said = format!(
            "edwinclient: cannot attach to edwind at {mute}: it closed the connection without answering"
        );
        assert!(contains(&t.out, said.as_bytes()), "{:?}", tail(&t.out));
        assert!(!contains(&t.out, b"\x1b[?1049h"), "the terminal was taken");
    }
    // Neither socket is known: the message says how to have one.
    let o = std::process::Command::new(&c)
        .arg("a.txt")
        .env_remove("EDWIN_SOCKET")
        .env_remove("XDG_RUNTIME_DIR")
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&o.stderr).contains("start one with `edwin --daemon`"),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let mut t = Pty::spawn_program(&d, &c, &["-a", "-c", "a.txt"], &env);
    assert_eq!(t.exit(), 1);
    t.pump(200);
    assert!(
        contains(
            &t.out,
            b"edwinclient: -a needs edwin-daemon beside the edwin program"
        ),
        "{:?}",
        tail(&t.out)
    );
    assert!(!contains(&t.out, b"\x1b[?1049h"), "the terminal was taken");
}

/// edwinclient -e: each form evaluated in edwind as a client of kind cli and its value printed, with no terminal;
/// a definition stays in edwind's image for the next client; the first error ends the run with status 1.
#[test]
fn eval_prints_values_and_stops_at_an_error() {
    if !have_node() {
        return;
    }
    let up = EdwindUp::start();
    let d = workdir("eval");
    let c = client(&d);
    let run = |args: &[&str]| {
        let mut cmd = std::process::Command::new(&c);
        cmd.arg("--socket")
            .arg(&up.socket)
            .args(args)
            .current_dir(&d)
            .env_clear()
            .env("HOME", &d)
            .env("PATH", std::env::var("PATH").unwrap_or_default());
        // SAFETY: setsid is async-signal-safe.
        unsafe {
            std::os::unix::process::CommandExt::pre_exec(&mut cmd, || {
                libc::setsid();
                Ok(())
            });
        }
        let o = cmd.output().unwrap();
        let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
        (o.status.code(), text(&o.stdout), text(&o.stderr))
    };
    let (code, out, err) = run(&["-e", "(+ 1 2)", "\"two\"", "(define edwinclient-test 41)"]);
    assert_eq!(code, Some(0), "{err}");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 3, "{out:?}");
    assert_eq!(lines[..2], ["3", "\"two\""]);
    let (code, out, err) = run(&["--eval", "(+ edwinclient-test 1)", "(car 5)", "(+ 1 1)"]);
    assert_eq!(code, Some(1));
    assert_eq!(out, "42\n");
    assert!(
        err.starts_with("edwinclient: ") && err.lines().count() == 1,
        "{err:?}"
    );
    up.finish();
}

/// Attaching to edwind needs Node and edwind's test harness (test/edit-client.mts); skipped without node.
#[test]
fn edwinclient_notes_go_through_edwind_and_other_files_stay_local() {
    if !have_node() {
        return;
    }
    let up = EdwindUp::start();
    let (socket, notes) = (up.socket.clone(), up.notes.clone());
    let d = workdir("attach");
    std::fs::write(d.join("local.txt"), "local\n").unwrap();
    // The note named through a link to the notes directory and a dot segment: still edwind's note.
    std::os::unix::fs::symlink(&notes, d.join("notes-link")).unwrap();
    let c = client(&d);
    let mut t = Pty::spawn_program(
        &d,
        &c,
        &["--socket", &socket, "./notes-link/./a.md", "local.txt"],
        &[],
    );
    t.ready();
    t.pump(500);
    t.keys("Gotyped in the terminal").esc().keys(":w\r");
    t.pump(500);
    t.keys(":e local.txt\r").keys("Aedited").esc().keys(":w\r");
    t.pump(300);
    // :wq on the note: edwind's save answers later, and the quit still goes through once it has.
    t.keys(":b a.md\r").keys("Goand quit").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("local.txt")), "localedited\n");
    // A save edwind refuses keeps the program open, as Vim stays when :wq cannot write; :q! still leaves.
    let b = Path::new(&notes).join("b.md");
    std::fs::write(&b, "b\n").unwrap();
    let mut t = Pty::spawn_program(&d, &c, &["--socket", &socket, "./notes-link/b.md"], &[]);
    t.ready();
    t.pump(500);
    t.keys("Gonot written").esc();
    t.pump(300);
    std::fs::remove_file(&b).unwrap();
    std::fs::create_dir(&b).unwrap();
    t.keys(":wq\r");
    t.pump(1500);
    t.reap(false);
    assert!(t.status.is_none(), "edwinclient quit after a refused save");
    assert!(
        contains(&t.out, b"not quitting"),
        "screen tail: {:?}",
        tail(&t.out)
    );
    t.keys(":q!\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(
        up.finish(),
        r##"{"server":"# Shared page\ntyped in the terminal\nand quit\n","disk":"# Shared page\ntyped in the terminal\nand quit\n","opened":["a.md","b.md"]}"##
    );
}

/// In edwinclient, dired asks edwind about the notes directory and lists every other directory itself.
#[test]
fn edwinclient_dired_asks_edwind_about_the_notes_only() {
    if !have_node() {
        return;
    }
    let up = EdwindUp::start();
    let (socket, notes) = (up.socket.clone(), up.notes.clone());
    let d = workdir("attach-dired");
    std::fs::write(d.join("local.txt"), "local\n").unwrap();
    let c = client(&d);
    let mut t = Pty::spawn_program(&d, &c, &["--socket", &socket, "local.txt"], &[]);
    t.ready();
    t.pump(500);
    // The program's own directory: the rename is done here.
    t.keys(" fd");
    t.pump(200);
    t.keys("\r");
    t.pump(300);
    t.keys("/local.txt\r").keys("R");
    t.pump(200);
    t.keys("moved.txt\r");
    t.pump(300);
    // The notes directory, typed after the offered one (a path starts again at //): edwind's commands.
    t.keys(" fd");
    t.pump(200);
    t.keys(&format!("{notes}/\r"));
    t.pump(500);
    t.keys("+");
    t.pump(200);
    t.keys("made\r");
    t.pump(500);
    t.keys("/a.md\r").keys("C");
    t.pump(200);
    t.keys("copy.md\r");
    t.pump(500);
    t.keys(":q!\r");
    assert_eq!(t.exit(), 0);
    assert!(!d.join("local.txt").exists());
    assert_eq!(read(d.join("moved.txt")), "local\n");
    assert!(Path::new(&notes).join("made").is_dir());
    assert_eq!(read(Path::new(&notes).join("copy.md")), "# Shared page\n");
    // edwind logs the changes it makes: the two in the notes, and not the rename.
    let after = up.finish();
    assert!(
        after.contains(r##""fs":["mkdir","copy"]"##),
        "edwind ran: {after}"
    );
}

/// The Node options the helpers need here (Node 22 runs .mts files only with --experimental-strip-types).
fn node_options() -> String {
    std::env::var("NODE_OPTIONS").unwrap_or_default()
}

/// --remote HOST: the edwind on another machine, through ssh (tests/fake-ssh stands in for it, with HOST here).
#[test]
fn remote_notes_go_through_ssh() {
    if !have_node() {
        return;
    }
    let up = EdwindUp::start();
    let d = workdir("remote");
    std::fs::write(d.join("local.txt"), "local\n").unwrap();
    let ssh = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-ssh");
    let ssh = ssh.to_str().unwrap();
    let remote = format!("box:{}", up.socket);
    // The same path on both machines here: as an argument, a full path is a file on this machine all the same.
    let here = format!("{}/here.md", up.notes);
    std::fs::write(&here, "here\n").unwrap();
    // A note is named as it is under the remote notes directory; ./local.txt is a file on this machine.
    let c = client(&d);
    let mut t = Pty::spawn_program(
        &d,
        &c,
        &["--remote", &remote, "a.md", "./local.txt", &here],
        &[("EDWIN_SSH", ssh), ("NODE_OPTIONS", &node_options())],
    );
    t.ready();
    t.pump(500);
    t.keys("Gotyped over ssh").esc().keys(":w\r");
    t.pump(500);
    t.keys(":e ./local.txt\r")
        .keys("Aedited")
        .esc()
        .keys(":w\r");
    t.pump(300);
    // Back to the note by its full path on the remote host.
    t.keys(&format!(":e {}/a.md\r", up.notes)).keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("local.txt")), "localedited\n");
    assert!(!d.join("a.md").exists(), "the note was written here");
    // ssh's reason when it cannot connect, and exit status 1, before the terminal is taken.
    let mut t = Pty::spawn_program(
        &d,
        &c,
        &["--remote", "unreachable:/run/edwind.sock", "a.md"],
        &[("EDWIN_SSH", ssh), ("NODE_OPTIONS", &node_options())],
    );
    assert_eq!(t.exit(), 1);
    t.pump(200);
    assert!(!contains(&t.out, b"\x1b[?1049h"), "the terminal was taken");
    assert!(
        contains(&t.out, b"Could not resolve hostname unreachable"),
        "screen tail: {:?}",
        tail(&t.out)
    );
    // An address without a socket names no edwind there.
    let mut t = Pty::spawn_program(
        &d,
        &c,
        &["--remote", "box", "a.md"],
        &[("EDWIN_SSH", ssh), ("NODE_OPTIONS", &node_options())],
    );
    assert_eq!(t.exit(), 1);
    t.pump(200);
    assert!(
        contains(&t.out, b"names no socket"),
        "screen tail: {:?}",
        tail(&t.out)
    );
    assert_eq!(
        up.finish(),
        r##"{"server":"# Shared page\ntyped over ssh\n","disk":"# Shared page\ntyped over ssh\n","opened":["a.md"]}"##
    );
}

/// edwinclient -a: no edwind answers, so it starts the user's (edwin-daemon beside the program; here one that runs
/// tests/edwind-at.mts) and attaches to it, as emacsclient -a '' does. When edwin-daemon refuses because an edwind
/// started meanwhile answers (BEATEN: the stand-in starts one and fails, as the real one does when another
/// edwinclient -a was first), edwinclient attaches to that one.
#[test]
fn dash_a_starts_the_daemon_and_attaches() {
    if !have_node() {
        return;
    }
    let d = workdir("dash-a");
    let bin = d.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::copy(BIN, bin.join("edwin")).unwrap();
    std::os::unix::fs::symlink("edwin", bin.join("edwinclient")).unwrap();
    let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/edwind-at.mts");
    let (run, notes, pidfile) = (d.join("run"), d.join("notes"), d.join("edwind.pid"));
    std::fs::create_dir_all(&notes).unwrap();
    std::fs::write(notes.join("a.md"), "# Mine\n").unwrap();
    let script = format!(
        "#!/bin/sh\nmkdir -p -m 700 \"$XDG_RUNTIME_DIR/edwin\"\nnohup node {} \"$XDG_RUNTIME_DIR/edwin/edit.sock\" {} {p} </dev/null >/dev/null 2>&1 &\n\
         [ -z \"$BEATEN\" ] && exit 0\nwhile [ ! -s {p} ]; do sleep 0.05; done\necho 'edwin: an edwind already runs' >&2; exit 1\n",
        helper.display(),
        notes.display(),
        p = pidfile.display()
    );
    std::fs::write(bin.join("edwin-daemon"), script).unwrap();
    std::fs::set_permissions(
        bin.join("edwin-daemon"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    std::fs::create_dir_all(&run).unwrap();
    let mut t = Pty::spawn_program(
        &d,
        bin.join("edwinclient").to_str().unwrap(),
        &["-a", "notes/a.md"],
        &[
            ("XDG_RUNTIME_DIR", run.to_str().unwrap()),
            ("NODE_OPTIONS", &node_options()),
        ],
    );
    t.ready();
    t.pump(500);
    t.keys("Gothrough the daemon").esc().keys(":wq\r");
    let code = t.exit();
    let pid: i32 = std::fs::read_to_string(&pidfile)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    // The daemon outlives the frame, as Emacs's does; the test stops it.
    if pid > 0 {
        // SAFETY: a signal to the helper this test started.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    assert_eq!(code, 0);
    assert!(
        pid > 0,
        "no daemon started; screen tail: {:?}",
        tail(&t.out)
    );
    assert_eq!(read(notes.join("a.md")), "# Mine\nthrough the daemon\n");
    // The note went through it: the terminal attached as a frame.
    let log = d.join("edwind.pid.log");
    let end = Instant::now() + Duration::from_secs(10);
    while !log.exists() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
    }
    let log = read(log);
    assert!(
        log.contains(r#""kind":"frame","device":"terminal""#),
        "edwind log: {log}"
    );
    std::fs::remove_file(&pidfile).unwrap();
    let o = std::process::Command::new(bin.join("edwinclient"))
        .args(["-a", "-e", "(+ 1 2)"])
        .current_dir(&d)
        .env_clear()
        .env("HOME", &d)
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("XDG_RUNTIME_DIR", &run)
        .env("NODE_OPTIONS", node_options())
        .env("BEATEN", "1")
        .output()
        .unwrap();
    let pid: i32 = std::fs::read_to_string(&pidfile)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if pid > 0 {
        // SAFETY: a signal to the helper this test started.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains("an edwind already runs"), "{err}");
    assert_eq!(o.status.code(), Some(0), "{err}");
    assert_eq!(String::from_utf8_lossy(&o.stdout), "3\n");
}
