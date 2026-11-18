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

/// A cloned repository decides what the .editorconfig search reads on every visit: a link to the terminal
/// (/dev/stdin, whose read never ends), a FIFO (whose open blocks) and a file past the 1 MiB bound are each
/// refused unread, as if absent, and the search goes on to the directory above, whose tab style applies.
/// (A link to /dev/zero is the terminal's case; it is not tested here, since before the bound it filled memory.)
#[test]
fn a_hostile_editorconfig_is_not_read() {
    let d = workdir("editorconfig");
    std::fs::write(
        d.join(".editorconfig"),
        "root = true\n[*]\nindent_style = tab\ntab_width = 4\n",
    )
    .unwrap();
    for sub in ["stdin", "fifo", "big"] {
        std::fs::create_dir(d.join(sub)).unwrap();
        std::fs::write(d.join(sub).join("a.txt"), "x\n").unwrap();
    }
    std::os::unix::fs::symlink("/dev/stdin", d.join("stdin/.editorconfig")).unwrap();
    let fifo = cstr(&d.join("fifo/.editorconfig").display().to_string());
    // SAFETY: a valid C string.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let big = format!(
        "[*]\nindent_style = space\n{}",
        "# padding\n".repeat((1 << 20) / 10 + 1)
    );
    std::fs::write(d.join("big/.editorconfig"), big).unwrap();
    for sub in ["stdin", "fifo", "big"] {
        let mut t = Pty::spawn(&d.join(sub), &["a.txt"], &[]);
        t.ready().keys("i\t").esc().keys(":wq\r");
        assert_eq!(t.exit(), 0, "{sub}");
        assert_eq!(read(d.join(sub).join("a.txt")), "\tx\n", "{sub}");
    }
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

/// The cell the last draw left the cursor on: the CSI y;x H before the cursor is shown (term.ts draw).
fn cursor_cell(out: &[u8]) -> (u32, u32) {
    let s = String::from_utf8_lossy(out);
    let end = s.rfind("H\x1b[?25h").expect("a drawn cursor");
    let start = s[..end].rfind("\x1b[").unwrap() + 2;
    let (y, x) = s[start..end].split_once(';').unwrap();
    (y.parse().unwrap(), x.parse().unwrap())
}

#[test]
fn plus_line_col_puts_the_cursor_on_that_cell() {
    let d = workdir("linecol");
    std::fs::write(d.join("l.txt"), "one\ntwo\nthree four\n").unwrap();
    // +3 gives the line's first cell, whatever sits left of the text; +3:5 is four cells on.
    let mut t = Pty::spawn(&d, &["+3", "l.txt"], &[]);
    t.ready().pump(200);
    let (y, x) = cursor_cell(&t.out);
    t.keys(":q\r");
    assert_eq!(t.exit(), 0);
    let mut t = Pty::spawn(&d, &["+3:5", "l.txt"], &[]);
    t.ready().pump(200);
    assert_eq!(
        cursor_cell(&t.out),
        (y, x + 4),
        "screen tail: {:?}",
        tail(&t.out)
    );
    t.keys("x:wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("l.txt")), "one\ntwo\nthre four\n");
}

#[test]
fn plus_line_col_counts_characters_and_stops_at_the_line_end() {
    for (text, arg, after) in [
        // One character that is two UTF-16 units.
        ("a\u{1F600}bc\n", "+1:3", "a\u{1F600}c\n"),
        // Past the end of the line: on its last character, as Vim puts it; not onto the next line.
        ("abc\nde\n", "+1:99", "ab\nde\n"),
        // Column 0 is the first, as line 0 is.
        ("ab\ncd\n", "+2:0", "ab\nd\n"),
        // Past the last line: on the last.
        ("ab\ncd\n", "+9:2", "ab\nc\n"),
    ] {
        let d = workdir("linecol-chars");
        std::fs::write(d.join("l.txt"), text).unwrap();
        let mut t = Pty::spawn(&d, &[arg, "l.txt"], &[]);
        t.ready().keys("x:wq\r");
        assert_eq!(t.exit(), 0, "{arg}");
        assert_eq!(read(d.join("l.txt")), after, "{arg} on {text:?}");
    }
    // Anything else after + is a file name, as Emacs takes it: main.rs and main.ts both leave it to the files.
    let d = workdir("linecol-name");
    let mut t = Pty::spawn(&d, &["+3:"], &[]);
    t.ready().keys("ihi").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("+3:")), "hi\n");
}

#[test]
fn edwinclient_plus_line_col_places_the_cursor() {
    if !have_node() {
        return;
    }
    let up = EdwindUp::start();
    let d = workdir("linecol-client");
    std::fs::write(d.join("l.txt"), "one\ntwo words\n").unwrap();
    let c = client(&d);
    let mut t = Pty::spawn_program(&d, &c, &["--socket", &up.socket, "+2:5", "l.txt"], &[]);
    t.ready();
    t.pump(300);
    t.keys("x:wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("l.txt")), "one\ntwo ords\n");
    up.finish();
}

/// -f COMMAND runs that command in the frame once the file is open and +LINE has placed point, with no key typed;
/// the user's init.scm can define the command.
#[test]
fn funcall_runs_a_command_in_the_frame() {
    let d = workdir("funcall");
    std::fs::create_dir_all(d.join("config/edwin")).unwrap();
    std::fs::write(
        d.join("config/edwin/init.scm"),
        "(define-command (funcall-test-mark)\n  \"Insert a mark.\"\n  (interactive \"*\")\n  (insert \"<f>\"))\n",
    )
    .unwrap();
    std::fs::write(d.join("f.txt"), "one two\nthree four\n").unwrap();
    for (args, after) in [
        (
            &["+2", "-f", "upcase-word", "f.txt"][..],
            "one two\nTHREE four\n",
        ),
        (
            // +1: save-place would start where the first run left.
            &["+1", "--funcall=funcall-test-mark", "f.txt"][..],
            "<f>one two\nTHREE four\n",
        ),
    ] {
        let mut t = Pty::spawn(&d, args, &[]);
        t.ready().pump(300);
        t.keys(":wq\r");
        assert_eq!(t.exit(), 0, "{args:?}: screen tail: {:?}", tail(&t.out));
        assert_eq!(read(d.join("f.txt")), after, "{args:?}");
    }
}

/// A name that is no command (nothing by that name, or a function that is not a command) ends edwin with status 1
/// and says so, before a frame is drawn or a file touched, and gives the terminal back.
#[test]
fn funcall_of_a_name_that_is_no_command_exits_1() {
    let d = workdir("funcall-none");
    std::fs::write(d.join("f.txt"), "one\n").unwrap();
    for name in ["no-such-command", "car"] {
        let mut t = Pty::spawn(&d, &["-f", name, "f.txt"], &[]);
        assert_eq!(t.exit(), 1, "{name}");
        t.pump(200);
        let said = format!("edwin: {name} is not a command");
        assert!(contains(&t.out, said.as_bytes()), "{:?}", tail(&t.out));
        assert!(!contains(&t.out, b"\x1b[?2026l"), "a frame was drawn");
        assert!(contains(&t.out, b"\x1b[?1049l"), "the terminal was kept");
    }
    assert_eq!(read(d.join("f.txt")), "one\n");
}

/// edwinclient -f: the command runs in the new frame of edwind, a command declared (:where 'server) runs in edwind
/// and answers there, and a name that is no command ends the client with status 1 before a frame is drawn.
#[test]
fn edwinclient_funcall_runs_a_command_in_the_frame() {
    if !have_node() {
        return;
    }
    let up = EdwindUp::start();
    let d = workdir("funcall-client");
    std::fs::write(d.join("f.txt"), "one two\n").unwrap();
    let c = client(&d);
    let sock = up.socket.clone();
    let mut t = Pty::spawn_program(
        &d,
        &c,
        &["--socket", &sock, "-f", "upcase-word", "f.txt"],
        &[],
    );
    t.ready().pump(300);
    t.keys(":wq\r");
    assert_eq!(t.exit(), 0, "screen tail: {:?}", tail(&t.out));
    assert_eq!(read(d.join("f.txt")), "ONE two\n");
    // image-log is edwind's: its answer is the buffer *image-log*, which the frame then shows.
    let mut t = Pty::spawn_program(&d, &c, &["--socket", &sock, "-f", "image-log"], &[]);
    t.ready().pump(800);
    assert!(
        contains(&t.out, b"*image-log*"),
        "screen tail: {:?}",
        tail(&t.out)
    );
    t.keys("\x18\x03");
    assert_eq!(t.exit(), 0);
    let mut t = Pty::spawn_program(
        &d,
        &c,
        &["--socket", &sock, "-f", "no-such-command", "f.txt"],
        &[],
    );
    assert_eq!(t.exit(), 1);
    t.pump(200);
    assert!(
        contains(&t.out, b"edwinclient: no-such-command is not a command"),
        "{:?}",
        tail(&t.out)
    );
    assert!(!contains(&t.out, b"\x1b[?2026l"), "a frame was drawn");
    assert_eq!(read(d.join("f.txt")), "ONE two\n");
    up.finish();
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
    // --title names the window that did not open: its NAME is not a file to edit.
    let mut t = Pty::spawn(&d, &["--gui", "--title", "b.txt", "a.txt"], &[]);
    t.ready().keys("Atwo").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert!(
        contains(&t.out, b"cannot open a window: no display"),
        "{}",
        tail(&t.out)
    );
    assert_eq!(read(d.join("a.txt")), "onetwo\n");
    assert!(!d.join("b.txt").exists());
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
    for opt in [
        "--socket=/x",
        "--remote",
        "-a",
        "--standalone",
        "-n",
        "--no-wait",
    ] {
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
    for args in [&["-g", "--title"][..], &["--title=", "a.txt"][..]] {
        let o = std::process::Command::new(BIN).args(args).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(
            String::from_utf8_lossy(&o.stderr).contains("edwin: --title needs a name"),
            "{args:?}"
        );
    }
    // -f takes a command's name, never a form; main.rs refuses what main.ts refuses, so no window opens first.
    for (args, said) in [
        (&["-f"][..], "edwin: -f needs a command's name"),
        (
            &["--funcall=", "a.txt"][..],
            "edwin: --funcall needs a command's name",
        ),
        (
            &["-f", "(delete-file \"a.txt\")", "a.txt"][..],
            "edwin: -f takes a command's name, not (delete-file \"a.txt\")",
        ),
        (
            &["-g", "--funcall=quick calc"][..],
            "edwin: --funcall takes a command's name, not quick calc",
        ),
        (
            &["-f", "upcase-word", "--funcall=kill-line", "a.txt"][..],
            "edwin: -f runs one command; give it once",
        ),
    ] {
        let o = std::process::Command::new(BIN).args(args).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(
            String::from_utf8_lossy(&o.stderr).contains(said),
            "{args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
    }
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
        (&["-c", "--title"][..], "edwinclient: --title needs a name"),
        (
            &["--title=", "a.txt"][..],
            "edwinclient: --title needs a name",
        ),
        (
            &["--socket=/a", "--remote", "h:/b"][..],
            "give one of them once",
        ),
        // -f as edwin takes it; refused before edwinclient looks for an edwind (which would be status 1).
        (&["-f"][..], "edwinclient: -f needs a command's name"),
        (
            &["-f", "(kill-emacs)", "a.txt"][..],
            "edwinclient: -f takes a command's name, not (kill-emacs)",
        ),
        (
            &["-c", "--funcall=a;b"][..],
            "edwinclient: --funcall takes a command's name, not a;b",
        ),
        (
            &["-f", "upcase-word", "-e", "1"][..],
            "edwinclient: -f runs a command in a frame, and -e opens none",
        ),
        (
            &["-c", "-f", "upcase-word", "-f", "kill-line"][..],
            "edwinclient: -f runs one command; give it once",
        ),
        // -n leaves a window, and only a window, behind; refused before it looks for an edwind or detaches.
        (
            &["-n", "a.txt"][..],
            "edwinclient: -n leaves the frame in a window of its own: give -c",
        ),
        (
            &["-c", "--no-wait", "-t", "a.txt"][..],
            "edwinclient: -n leaves the frame in a window of its own: give -c",
        ),
        (
            &["-n", "-c", "-"][..],
            "edwinclient: -n reads no standard input (-): the frame outlives this command",
        ),
        (
            &["-c", "-n", "-e", "1"][..],
            "edwinclient: -n leaves a frame open, and -e opens none",
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

/// edwinclient -n -c with no display to open the window on: said, with status 1, before it detaches, and at once;
/// the terminal it was run from is not taken.
#[test]
fn no_wait_without_a_display_says_so_and_leaves_the_terminal_alone() {
    let d = workdir("no-wait-no-display");
    let c = client(&d);
    let run = d.join("run");
    std::fs::create_dir_all(&run).unwrap();
    let t0 = Instant::now();
    let mut t = Pty::spawn_program(
        &d,
        &c,
        &["-n", "-c", "a.txt"],
        &[("XDG_RUNTIME_DIR", run.to_str().unwrap())],
    );
    assert_eq!(t.exit(), 1);
    assert!(t0.elapsed() < Duration::from_secs(1), "{:?}", t0.elapsed());
    t.pump(200);
    assert!(
        contains(
            &t.out,
            b"edwinclient: cannot open a window: no display (DISPLAY and WAYLAND_DISPLAY are unset)"
        ),
        "{:?}",
        tail(&t.out)
    );
    assert!(!contains(&t.out, b"\x1b[?1049h"), "the terminal was taken");
    assert!(!d.join("a.txt").exists());
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

/// The default background of the Modus palettes (src/display.ts PALETTE), as truecolor SGR.
const DARK_BG: &[u8] = b"48;2;13;14;28";
const LIGHT_BG: &[u8] = b"48;2;251;247;240";

#[test]
fn the_frame_follows_the_terminals_colour_scheme_reports() {
    let d = workdir("scheme");
    std::fs::write(d.join("s.txt"), "scheme\n").unwrap();
    let mut t = Pty::spawn(&d, &["s.txt"], &[("COLORTERM", "truecolor")]);
    // The pty answers the background query dark and never the scheme query: a terminal that does not
    // report its scheme stays on what it found out.
    t.ready();
    assert!(
        contains(&t.out, b"\x1b[?2031h") && contains(&t.out, b"\x1b[?996n"),
        "edwin asks for colour-scheme reports"
    );
    assert!(contains(&t.out, DARK_BG) && !contains(&t.out, LIGHT_BG));
    t.take();
    t.send_raw(b"\x1b[?997;2n");
    t.pump(200);
    let out = t.take();
    assert!(
        contains(&out, LIGHT_BG) && !contains(&out, DARK_BG),
        "a light report repaints light: {:?}",
        tail(&out)
    );
    t.send_raw(b"\x1b[?997;1n");
    t.pump(200);
    let out = t.take();
    assert!(
        contains(&out, DARK_BG) && !contains(&out, LIGHT_BG),
        "a dark report repaints dark: {:?}",
        tail(&out)
    );
    t.keys(":q\r");
    assert_eq!(t.exit(), 0);
    assert!(
        contains(&t.out, b"\x1b[?2031l"),
        "leaving stops the reports"
    );
}

#[test]
fn edwin_theme_wins_over_the_terminals_scheme_reports() {
    let d = workdir("scheme-forced");
    std::fs::write(d.join("s.txt"), "scheme\n").unwrap();
    let mut t = Pty::spawn(
        &d,
        &["s.txt"],
        &[("COLORTERM", "truecolor"), ("EDWIN_THEME", "dark")],
    );
    t.ready();
    t.take();
    t.send_raw(b"\x1b[?997;2n");
    t.pump(200);
    t.keys("x");
    assert!(
        !contains(&t.out, LIGHT_BG),
        "EDWIN_THEME=dark stays dark: {:?}",
        tail(&t.out)
    );
    assert!(contains(&t.out, DARK_BG), "the edit is drawn dark");
    t.keys(":q!\r");
    assert_eq!(t.exit(), 0);
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

/// global-auto-revert-mode in the program: another program's write (a new file renamed over the old one: a new
/// inode) reaches the unmodified buffer, point on its line; saving a changed buffer over a file changed since asks.
/// A file under $TMPDIR is never looked at.
#[test]
fn a_buffer_follows_its_file_and_a_save_over_a_change_asks() {
    let d = workdir("autorevert");
    std::fs::create_dir_all(d.join("config/edwin")).unwrap();
    std::fs::write(
        d.join("config/edwin/init.scm"),
        "(set! auto-revert-interval 1)\n",
    )
    .unwrap();
    std::fs::create_dir_all(d.join("tmp")).unwrap();
    let (a, tmp) = (d.join("a.txt"), d.join("tmp").display().to_string());
    std::fs::write(&a, "one\ntwo\n").unwrap();
    let mut t = Pty::spawn(&d, &["a.txt"], &[("TMPDIR", &tmp)]);
    t.ready().keys("j");
    std::fs::write(d.join("a.new"), "zero\none\ntwo\n").unwrap();
    std::fs::rename(d.join("a.new"), &a).unwrap();
    t.pump(2500);
    assert!(
        contains(&t.out, b"Reverted a.txt"),
        "no revert: {:?}",
        tail(&t.out)
    );
    // Point stayed on "two", now line 3: x takes its t.
    t.keys("x");
    std::fs::write(&a, "outside\n").unwrap();
    t.pump(1500);
    t.keys(":w\r");
    t.pump(200);
    assert!(
        contains(&t.out, b"changed on disk; save anyway?"),
        "no question: {:?}",
        tail(&t.out)
    );
    t.keys("n");
    t.pump(100);
    assert_eq!(read(&a), "outside\n", "n keeps the other program's file");
    t.keys(":w\r");
    t.pump(200);
    t.keys("y");
    t.pump(100);
    assert_eq!(read(&a), "zero\none\nwo\n");
    t.keys(":q\r");
    assert_eq!(t.exit(), 0);

    // The same file with $TMPDIR its directory: the write is not looked at, and the save does not ask.
    let home = d.display().to_string();
    let mut t = Pty::spawn(&d, &["a.txt"], &[("TMPDIR", &home)]);
    t.ready();
    std::fs::write(&a, "sops\n").unwrap();
    t.pump(2500);
    assert!(
        !contains(&t.out, b"Reverted"),
        "a temporary file was looked at"
    );
    t.keys("ggx:wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(&a), "ero\none\nwo\n");
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
    for args in [
        &["--socket", mute, "a.txt"][..],
        &["--socket", mute, "-e", "1"],
    ] {
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

/// An Org https link goes to the desktop's opener (native/src/open.rs): the `xdg-open` found on PATH, given
/// exactly the URL as its one argument, never through a shell.
#[test]
fn an_org_https_link_goes_to_xdg_open_on_path() {
    use std::os::unix::fs::PermissionsExt;
    let d = workdir("open");
    let bin = d.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let fake = bin.join("xdg-open");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$0\" \"$@\" > {0}/argv.tmp\nmv {0}/argv.tmp {0}/argv\n",
            d.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let url = "https://example.org/a?b=$HOME;touch%20x&c=`id`";
    std::fs::create_dir_all(d.join("config/edwin")).unwrap();
    std::fs::write(
        d.join("config/edwin/init.scm"),
        format!("(switch-to-buffer \"links.org\")\n(org-mode)\n(insert \"[[{url}][paper]]\")\n(goto-char 3)\n(org-open-at-point)\n"),
    )
    .unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut t = Pty::spawn(&d, &[], &[("PATH", &path)]);
    t.ready();
    let end = Instant::now() + Duration::from_secs(10);
    while !d.join("argv").exists() {
        assert!(
            Instant::now() < end,
            "xdg-open never ran; screen tail: {:?}",
            tail(&t.out)
        );
        t.pump(20);
    }
    assert_eq!(read(d.join("argv")), format!("{}\n{url}\n", fake.display()));
    t.keys(":qa!\r");
    assert_eq!(t.exit(), 0, "screen tail: {:?}", tail(&t.out));
}

/// A language server M-x eglot started (here by -f) is told shutdown and exit when edwin quits, and has ended by
/// the time edwin has: the stand-in server logs each message it gets, with its pid.
#[test]
fn quitting_shuts_the_language_servers_down() {
    if !have_node() {
        return;
    }
    let d = workdir("lsp-quit");
    std::fs::create_dir_all(d.join("config/edwin")).unwrap();
    std::fs::create_dir_all(d.join("proj/.git")).unwrap();
    std::fs::write(d.join("proj/x.nix"), "1\n").unwrap();
    let server = d.join("server.cjs");
    let log = d.join("log");
    std::fs::write(
        &server,
        r#"const fs = require('fs'), log = process.argv[2];
const note = s => fs.appendFileSync(log, process.pid + ' ' + s + '\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\r\n\r\n'); process.stdout.write(b); };
let buf = Buffer.alloc(0);
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const n = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1]);
    if (buf.length < end + 4 + n) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + n).toString('utf8'));
    buf = buf.subarray(end + 4 + n);
    note(m.method);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } });
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
  }
});
setInterval(() => {}, 1000);
"#,
    )
    .unwrap();
    std::fs::write(
        d.join("config/edwin/init.scm"),
        format!(
            "(define-language-server 'fake :modes '(nix-mode) :command '(\"node\" {:?} {:?}))\n",
            server.display().to_string(),
            log.display().to_string()
        ),
    )
    .unwrap();
    let mut t = Pty::spawn(&d, &["-f", "eglot", "proj/x.nix"], &[]);
    t.ready();
    let end = Instant::now() + Duration::from_secs(10);
    while !(log.exists() && read(&log).contains(" initialized\n")) {
        assert!(
            Instant::now() < end,
            "the server was never initialized; screen tail: {:?}",
            tail(&t.out)
        );
        t.pump(20);
    }
    t.keys(":q\r");
    assert_eq!(t.exit(), 0, "screen tail: {:?}", tail(&t.out));
    let got = read(&log);
    let methods: Vec<&str> = got
        .lines()
        .map(|l| l.split_once(' ').unwrap().1)
        .collect();
    assert_eq!(methods, ["initialize", "initialized", "shutdown", "exit"]);
    let pid: libc::pid_t = got.split_once(' ').unwrap().0.parse().unwrap();
    // Ended: gone, or a zombie its new parent has not reaped yet.
    let running = || {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|s| !s.rsplit_once(") ").is_some_and(|(_, r)| r.starts_with('Z')))
            .unwrap_or(false)
    };
    let end = Instant::now() + Duration::from_secs(2);
    while running() {
        assert!(Instant::now() < end, "the server {pid} is still running");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A stand-in `nixd` in D/bin, for the shipped server table to find on PATH: it logs each message it gets (the
/// settings of a workspace/didChangeConfiguration with it) to D/log. The PATH to give the program, and the log.
fn table_nixd(d: &Path) -> (String, PathBuf) {
    std::fs::create_dir_all(d.join("bin")).unwrap();
    std::fs::create_dir_all(d.join("proj/.git")).unwrap();
    std::fs::write(d.join("proj/x.nix"), "1\n").unwrap();
    let log = d.join("log");
    let _ = std::fs::remove_file(&log);
    std::fs::write(
        d.join("server.cjs"),
        r#"const fs = require('fs'), log = process.argv[2];
const note = s => fs.appendFileSync(log, s + '\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\r\n\r\n'); process.stdout.write(b); };
let buf = Buffer.alloc(0);
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const n = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1]);
    if (buf.length < end + 4 + n) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + n).toString('utf8'));
    buf = buf.subarray(end + 4 + n);
    note(m.method === 'workspace/didChangeConfiguration' ? m.method + ' ' + JSON.stringify(m.params.settings) : m.method);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } });
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
  }
});
setInterval(() => {}, 1000);
"#,
    )
    .unwrap();
    let nixd = d.join("bin/nixd");
    std::fs::write(
        &nixd,
        format!(
            "#!/bin/sh\nexec node {:?} {:?}\n",
            d.join("server.cjs").display().to_string(),
            log.display().to_string()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&nixd, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        d.join("bin").display(),
        std::env::var("PATH").unwrap_or_default()
    );
    (path, log)
}

/// What the stand-in of table_nixd logged once the program in T has quit: the server started by visiting
/// proj/x.nix, with nixd's settings from the table, then shut down.
fn table_nixd_quit(t: &mut Pty, log: &Path) {
    let end = Instant::now() + Duration::from_secs(10);
    while !(log.exists() && read(log).contains("initialized\n")) {
        assert!(
            Instant::now() < end,
            "nixd was never initialized; screen tail: {:?}",
            tail(&t.out)
        );
        t.pump(20);
    }
    t.keys(":q\r");
    assert_eq!(t.exit(), 0, "screen tail: {:?}", tail(&t.out));
    assert_eq!(
        read(log),
        "initialize\ninitialized\nworkspace/didChangeConfiguration {\"nixd\":{\"nixpkgs\":{\"expr\":\"import <nixpkgs> { }\"}}}\nshutdown\nexit\n"
    );
}

/// The shipped server table (scm/lsp.scm) is the program's own: visiting a Nix file in edwin, with no init.scm,
/// starts the `nixd` found on PATH with the table's settings.
#[test]
fn the_server_table_starts_nixd_in_edwin() {
    if !have_node() {
        return;
    }
    let d = workdir("lsp-table");
    let (path, log) = table_nixd(&d);
    let mut t = Pty::spawn(&d, &["proj/x.nix"], &[("PATH", &path)]);
    t.ready();
    table_nixd_quit(&mut t, &log);
}

/// The same in an edwinclient frame: the frame evaluates its own scm/lsp.scm, not edwind's image, so the table is
/// there and the server runs on the frame's machine.
#[test]
fn the_server_table_starts_nixd_in_edwinclient() {
    if !have_node() {
        return;
    }
    let up = EdwindUp::start();
    let d = workdir("lsp-table-client");
    let (path, log) = table_nixd(&d);
    let c = client(&d);
    let mut t = Pty::spawn_program(
        &d,
        &c,
        &["--socket", &up.socket, "proj/x.nix"],
        &[("PATH", &path)],
    );
    t.ready();
    table_nixd_quit(&mut t, &log);
    up.finish();
}

/// The 40 ms first draw (docs/steps.md, "Step DT1"), in an 80x24 terminal: edwin started from its snapshot with no
/// file, and on a plain Org note, logs `startup first draw N ms` under EDWIN_TRACE within 40 ms of its start, the
/// best of five starts each. The program runs as the package lays it out (a copy of the binary in bin/ beside
/// share/edwin/grammars, the bundle EDWIN_TEST_GRAMMARS names). A note of 40 source blocks in Python, Nix and
/// Rust is measured and printed but not held to 40 ms: its first draw loads those three grammars and compiles
/// their highlights queries, once a process, as opening a file in each language does (docs/steps.md, "Org
/// source blocks highlighted with their grammars"). Wall-clock, so ignored as the other timing tests are; run
/// with `-- --ignored first_draw`.
#[test]
#[ignore]
fn the_first_draw_is_within_40_ms() {
    let grammars = PathBuf::from(
        std::env::var_os("EDWIN_TEST_GRAMMARS")
            .expect("set EDWIN_TEST_GRAMMARS to a grammar bundle (nix build .#edwin-grammars)"),
    );
    let d = workdir("first-draw");
    std::fs::create_dir_all(d.join("prog/bin")).unwrap();
    std::fs::create_dir_all(d.join("prog/share/edwin")).unwrap();
    let bin = d.join("prog/bin/edwin");
    std::fs::copy(BIN, &bin).unwrap();
    std::os::unix::fs::symlink(&grammars, d.join("prog/share/edwin/grammars")).unwrap();
    let mut blocks = String::from("#+title: Blocks\n");
    for i in 0..40 {
        let (lang, body) = [
            ("python", "def f(x):\n    return x + 1  # one\n"),
            ("nix", "{ pkgs, ... }: let a = \"b\"; in a\n"),
            ("rust", "fn main() { let v = 1; }\n"),
        ][i % 3];
        blocks += &format!("* Block {i}\n#+begin_src {lang}\n{body}#+end_src\n");
    }
    std::fs::write(d.join("blocks.org"), blocks).unwrap();
    std::fs::write(
        d.join("plain.org"),
        "* A heading\nSome *text*.\n".repeat(40),
    )
    .unwrap();
    let log = d.join("state/edwin/edwin.log");
    let first_draw = |args: &[&str]| {
        let mut best = f64::INFINITY;
        for _ in 0..5 {
            let _ = std::fs::remove_file(&log);
            let mut t =
                Pty::spawn_program(&d, bin.to_str().unwrap(), args, &[("EDWIN_TRACE", "1")]);
            t.ready();
            let end = Instant::now() + Duration::from_secs(10);
            let ms = loop {
                let text = std::fs::read_to_string(&log).unwrap_or_default();
                if let Some(ms) = text
                    .lines()
                    .find_map(|l| l.split("startup first draw ").nth(1))
                    .and_then(|s| s.trim_end_matches(" ms").parse::<f64>().ok())
                {
                    break ms;
                }
                assert!(Instant::now() < end, "no first draw in the log: {text}");
                t.pump(20);
            };
            best = best.min(ms);
            t.keys(":q!\r");
            assert_eq!(t.exit(), 0, "screen tail: {:?}", tail(&t.out));
        }
        best
    };
    let (none, plain, blocks) = (
        first_draw(&[]),
        first_draw(&["plain.org"]),
        first_draw(&["blocks.org"]),
    );
    let report = format!(
        "first draw: no file {none:.1} ms, a plain Org note {plain:.1} ms, a note of source blocks {blocks:.1} ms"
    );
    eprintln!("{report}");
    assert!(none <= 40.0 && plain <= 40.0, "{report}");
}
