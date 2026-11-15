//! edwin in a window (DT2), on a virtual X display: keys and the mouse as a person sends them (xdotool), the
//! close button, the keystroke-to-screen latency budget, edwinclient -c and -n -c, and the window's WM_CLASS and
//! --title.
//!
//! Each test starts its own Xvfb. Without Xvfb, xdotool or xprop, or without a GPU adapter (lavapipe will do), the
//! tests say so and pass, unless EDWIN_TEST_REQUIRE_GUI is set (the package's check sets it): then they fail.
#![cfg(feature = "gui")]

use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

mod common;

const BIN: &str = env!("CARGO_BIN_EXE_edwin");

/// TEST cannot run here, for WHY: it passes, saying so on its standard error, or fails under EDWIN_TEST_REQUIRE_GUI.
/// (cargo test hides a passing test's output, so a skip and a run look alike in a build log.)
fn skipped(test: &str, why: &str) {
    assert!(
        std::env::var_os("EDWIN_TEST_REQUIRE_GUI").is_none(),
        "{test}: cannot run ({why}), and EDWIN_TEST_REQUIRE_GUI is set"
    );
    eprintln!("{test}: skipped ({why})");
}

fn has(program: &str, arg: &str) -> bool {
    Command::new(program)
        .arg(arg)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

/// A virtual X display, stopped when dropped.
struct Display {
    name: String,
    xvfb: Child,
}

impl Display {
    fn start(test: &str) -> Option<Display> {
        if !has("Xvfb", "-help") || !has("xdotool", "version") || !has("xprop", "-version") {
            skipped(test, "needs Xvfb, xdotool and xprop");
            return None;
        }
        // A display number of this process's own, one per test.
        let n = 300 + (std::process::id() % 200) * 10 + test.len() as u32 % 10;
        let _ = std::fs::remove_file(format!("/tmp/.X11-unix/X{n}"));
        let xvfb = Command::new("Xvfb")
            .args([
                &format!(":{n}"),
                "-screen",
                "0",
                "1920x1200x24",
                "-nolisten",
                "tcp",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let d = Display {
            name: format!(":{n}"),
            xvfb,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !Path::new(&format!("/tmp/.X11-unix/X{n}")).exists() {
            if Instant::now() > deadline {
                skipped(test, "Xvfb did not start");
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Some(d)
    }

    fn xdo(&self, args: &[&str]) -> String {
        let o = Command::new("xdotool")
            .args(args)
            .env("DISPLAY", &self.name)
            .output()
            .unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    /// The X property PROP of window WIN, as xprop prints it: `NAME(TYPE) = VALUE`.
    fn prop(&self, win: &str, prop: &str) -> String {
        let o = Command::new("xprop")
            .args(["-id", win, prop])
            .env("DISPLAY", &self.name)
            .output()
            .expect("xprop");
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }
}

impl Drop for Display {
    fn drop(&mut self) {
        let _ = self.xvfb.kill();
        let _ = self.xvfb.wait();
    }
}

/// edwin --gui (or edwinclient -c) in DIR on display D.
struct Edwin<'a> {
    d: &'a Display,
    child: Child,
    log: PathBuf,
    win: String,
    cell: (i32, i32),
}

impl<'a> Edwin<'a> {
    /// Runs edwin --gui with ARGS and waits for its window; None when no window could open here (no GPU adapter).
    fn open(d: &'a Display, dir: &Path, args: &[&str], env: &[(&str, &str)]) -> Option<Edwin<'a>> {
        Edwin::open_program(d, dir, BIN, "--gui", args, env, FRAME_TITLE)
    }

    /// PROGRAM with FLAG (the one asking for a window) and ARGS, as open; the window is the one whose title
    /// matches the regular expression TITLE.
    fn open_program(
        d: &'a Display,
        dir: &Path,
        program: &str,
        flag: &str,
        args: &[&str],
        env: &[(&str, &str)],
        title: &str,
    ) -> Option<Edwin<'a>> {
        let log = dir.join("stderr.log");
        // The frame's own log (console, EDWIN_TRACE's steps): this run's alone.
        let trace = dir.join("state/edwin/edwin.log");
        let _ = std::fs::remove_file(&trace);
        let child = Command::new(program)
            .arg(flag)
            .args(args)
            .current_dir(dir)
            .env("DISPLAY", &d.name)
            .env_remove("WAYLAND_DISPLAY")
            .env("HOME", dir)
            .env("XDG_STATE_HOME", dir.join("state"))
            .env("XDG_CONFIG_HOME", dir.join("config"))
            .env_remove("EDWIN_SOCKET")
            .env_remove("XDG_RUNTIME_DIR")
            .env("EDWIN_TRACE", "1")
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(&log).unwrap())
            .spawn()
            .unwrap();
        let mut e = Edwin {
            d,
            child,
            log,
            win: String::new(),
            cell: (0, 0),
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        while e.win.is_empty() {
            if let Ok(Some(_)) = e.child.try_wait() {
                // No window can open here (no GPU adapter): skipped. Any other early end is a failure.
                let err = e.stderr();
                assert!(
                    err.contains("cannot open a window"),
                    "{program} ended before its window appeared: {err}"
                );
                skipped(program, &format!("no window here: {err}"));
                return None;
            }
            assert!(
                Instant::now() < deadline,
                "the window did not appear: {}",
                e.stderr()
            );
            std::thread::sleep(Duration::from_millis(100));
            e.win = d
                .xdo(&["search", "--name", title])
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
        }
        // A window titled by --title is there before the frame has drawn in it, so the frame's first draw is waited
        // for too.
        while !std::fs::read_to_string(&trace)
            .unwrap_or_default()
            .contains("startup first draw")
        {
            assert!(
                Instant::now() < deadline,
                "the frame did not draw: {}",
                e.stderr()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        // The trace line says the cell's size: "... cell 8x21, scale 1".
        let err = e.stderr();
        let cell = err
            .split("cell ")
            .nth(1)
            .and_then(|s| s.split(',').next())
            .unwrap_or("8x21");
        let (w, h) = cell.split_once('x').unwrap();
        e.cell = (w.parse().unwrap(), h.parse().unwrap());
        d.xdo(&["mousemove", "300", "300"]);
        d.xdo(&["windowfocus", &e.win]);
        e.settle();
        Some(e)
    }

    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    fn settle(&self) {
        std::thread::sleep(Duration::from_millis(300));
    }

    fn typed(&self, s: &str) -> &Self {
        self.d.xdo(&["type", "--delay", "20", s]);
        self
    }

    fn key(&self, k: &str) -> &Self {
        self.d.xdo(&["key", k]);
        self
    }

    /// A click on the cell at (COL, ROW).
    fn click(&self, col: i32, row: i32) -> &Self {
        let (x, y) = (
            2 + col * self.cell.0 + self.cell.0 / 2,
            2 + row * self.cell.1 + self.cell.1 / 2,
        );
        self.d.xdo(&[
            "mousemove",
            "--window",
            &self.win,
            &x.to_string(),
            &y.to_string(),
            "click",
            "1",
        ]);
        self
    }

    fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn exit(&mut self) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.code().unwrap_or(-1);
            }
            assert!(
                Instant::now() < deadline,
                "edwin did not leave: {}",
                self.stderr()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// What a window manager sends when the close button is pressed.
    fn close_button(&self) {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{ClientMessageEvent, ConnectionExt, EventMask};
        let (c, _) = x11rb::connect(Some(&self.d.name)).unwrap();
        let atom = |n: &str| {
            c.intern_atom(false, n.as_bytes())
                .unwrap()
                .reply()
                .unwrap()
                .atom
        };
        let (protocols, delete) = (atom("WM_PROTOCOLS"), atom("WM_DELETE_WINDOW"));
        let win: u32 = self.win.parse().unwrap();
        let ev = ClientMessageEvent::new(32, win, protocols, [delete, 0, 0, 0, 0]);
        c.send_event(false, win, EventMask::NO_EVENT, ev)
            .unwrap()
            .check()
            .unwrap();
        c.flush().unwrap();
    }
}

/// The title a window has once the frame has drawn in it, without --title: "BUFFER - Edwin".
const FRAME_TITLE: &str = " - Edwin$";
/// The WM_CLASS of every window, whichever program opened it.
const WM_CLASS: &str = r#"WM_CLASS(STRING) = "edwin", "edwin""#;

impl Drop for Edwin<'_> {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn workdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("edwin-gui-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn read(p: impl AsRef<Path>) -> String {
    std::fs::read_to_string(p).unwrap()
}

#[test]
fn keys_and_clicks_edit_and_wq_leaves_zero() {
    let Some(d) = Display::start("keys") else {
        return;
    };
    let dir = workdir("keys");
    std::fs::write(dir.join("a.txt"), "hello world\nsecond line\n").unwrap();
    let Some(mut e) = Edwin::open(&d, &dir, &["a.txt"], &[]) else {
        return;
    };
    e.typed("Atyped").key("Escape");
    // A click past the end of the second line puts point on its last character (Vim's normal state).
    e.click(60, 1).typed("x");
    e.typed("gg").key("ctrl+v").typed("jI> ").key("Escape");
    e.typed(":wq").key("Return");
    assert_eq!(e.exit(), 0, "{}", e.stderr());
    assert_eq!(
        read(dir.join("a.txt")),
        "> hello worldtyped\n> second lin\n"
    );
}

#[test]
fn the_close_button_asks_about_changes() {
    let Some(d) = Display::start("close") else {
        return;
    };
    let dir = workdir("close");
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    let Some(mut e) = Edwin::open(&d, &dir, &["a.txt"], &[]) else {
        return;
    };
    e.close_button();
    assert_eq!(e.exit(), 0, "with no changes the window closes at once");
    let Some(mut e) = Edwin::open(&d, &dir, &["a.txt"], &[]) else {
        return;
    };
    e.typed("Atwo").key("Escape");
    e.close_button();
    e.settle();
    assert!(e.running(), "a changed file is asked about first");
    e.typed("y");
    assert_eq!(e.exit(), 0);
    assert_eq!(read(dir.join("a.txt")), "onetwo\n");
}

/// edwinclient -c: a frame of edwind in a window of its own; what is typed in it reaches edwind's note. It is
/// opened as the scratch popup opens it (--title), and its WM_CLASS is edwin's, not the program's name (winit's
/// default is argv[0]'s).
#[test]
fn edwinclient_c_is_a_frame_of_edwind_in_a_window() {
    if !common::have_node() {
        skipped("client", "no node");
        return;
    }
    let Some(d) = Display::start("client") else {
        return;
    };
    let up = common::EdwindUp::start();
    let dir = workdir("client");
    let c = common::client(&dir);
    let note = format!("{}/a.md", up.notes);
    let args = ["--title", "org-scratch", "--socket", &up.socket, &note];
    let Some(mut e) = Edwin::open_program(&d, &dir, &c, "-c", &args, &[], "^org-scratch$") else {
        return;
    };
    assert_eq!(d.prop(&e.win, "WM_CLASS"), WM_CLASS);
    e.settle();
    e.typed("Gotyped in the window").key("Escape");
    e.settle();
    assert_eq!(
        d.prop(&e.win, "_NET_WM_NAME"),
        r#"_NET_WM_NAME(UTF8_STRING) = "org-scratch""#
    );
    e.typed(":wq").key("Return");
    assert_eq!(e.exit(), 0, "{}", e.stderr());
    assert_eq!(
        up.finish(),
        r##"{"server":"# Shared page\ntyped in the window\n","disk":"# Shared page\ntyped in the window\n","opened":["a.md"]}"##
    );
}

/// A process of this test's, killed and reaped when dropped, unless reaped before (0).
struct Pid(i32);
impl Drop for Pid {
    fn drop(&mut self) {
        if self.0 > 0 {
            // SAFETY: a signal to, and a wait for, a process this test made its own.
            unsafe {
                libc::kill(self.0, libc::SIGKILL);
                libc::waitpid(self.0, std::ptr::null_mut(), 0);
            }
        }
    }
}

/// The fields of /proc/PID/stat after the command's name: [state, ppid, pgrp, session, tty_nr, ...], or none
/// when there is no such process.
fn proc_stat(pid: i32) -> Vec<String> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    match s.rfind(") ") {
        Some(i) => s[i + 2..].split(' ').map(str::to_string).collect(),
        None => Vec::new(),
    }
}

/// The processes whose parent is this test's process and whose working directory is DIR.
fn children_in(dir: &Path) -> Vec<i32> {
    let (me, here) = (std::process::id().to_string(), dir.canonicalize().unwrap());
    std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<i32>().ok())
        .filter(|&pid| {
            proc_stat(pid).get(1) == Some(&me)
                && std::fs::read_link(format!("/proc/{pid}/cwd")).is_ok_and(|c| c == here)
        })
        .collect()
}

/// edwinclient -n -c returns at once, within 1 s, with status 0, and the window stays: a frame of edwind in a
/// process of its own session (so with no controlling terminal), with /dev/null for its standard input and output,
/// its log for its standard error, and none of the caller's other descriptors, so reading the command's output to
/// its end, as `$(...)` does, is not held until the window closes. Nothing is left between the frame and the caller
/// (this test is a subreaper: the frame is its child once edwinclient has returned) and nothing is left over: the
/// frame exits 0 on :wq and is reaped. What can fail before it returns (no edwind answering, a display that does
/// not answer) is said with status 1, and no frame is left; what fails in the frame after (-f NAME that is no
/// command) is in its log.
#[test]
fn edwinclient_n_returns_at_once_and_the_window_stays() {
    if !common::have_node() {
        skipped("no-wait", "no node");
        return;
    }
    let Some(d) = Display::start("no-wait") else {
        return;
    };
    let up = common::EdwindUp::start();
    let dir = workdir("no-wait");
    let c = common::client(&dir);
    let note = format!("{}/a.md", up.notes);
    // edwinclient with ARGS, and EXTRA, a descriptor of the test's, inherited, and ENV over the rest; its output
    // read to the end, then its status, and how long that took.
    let edwinclient = |args: &[&str], extra: Option<RawFd>, env: &[(&str, &str)]| {
        let mut cmd = Command::new(&c);
        cmd.args(args)
            .current_dir(&dir)
            .env("DISPLAY", &d.name)
            .env_remove("WAYLAND_DISPLAY")
            .env("HOME", &dir)
            .env("XDG_STATE_HOME", dir.join("state"))
            .env("XDG_CONFIG_HOME", dir.join("config"))
            .env_remove("EDWIN_SOCKET")
            .env_remove("XDG_RUNTIME_DIR")
            .env_remove("EDWIN_LOG")
            .env("EDWIN_TRACE", "1")
            .envs(env.iter().copied())
            .stdin(Stdio::null());
        if let Some(fd) = extra {
            // SAFETY: fcntl is async-signal-safe. Only this child gets FD: it is close-on-exec everywhere else, so
            // the other tests' children do not hold it.
            unsafe {
                std::os::unix::process::CommandExt::pre_exec(&mut cmd, move || {
                    libc::fcntl(fd, libc::F_SETFD, 0);
                    Ok(())
                });
            }
        }
        let t0 = Instant::now();
        let o = cmd.output().unwrap();
        (o, t0.elapsed())
    };
    // SAFETY: prctl on this process. The frame, orphaned when edwinclient returns, becomes this process's child.
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
        0
    );

    // No edwind answers: said here, with status 1, and no frame is started.
    let missing = dir.join("missing.sock").display().to_string();
    let (o, took) = edwinclient(&["-n", "-c", "--socket", &missing, &note], None, &[]);
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    assert_eq!(o.status.code(), Some(1), "{err}");
    assert!(
        err.contains(&format!("edwinclient: cannot attach to edwind at {missing}")),
        "{err}"
    );
    assert!(took < Duration::from_secs(1), "{took:?}");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(children_in(&dir), Vec::<i32>::new(), "a frame was left");

    // A display that does not answer (a stale DISPLAY), with an edwind that does: said here, with status 1, as the
    // display is connected to before detaching, and no frame is started. (This suite's displays are :300 to :2299.)
    let stale = format!("{}7", d.name);
    assert!(!Path::new(&format!("/tmp/.X11-unix/X{}", &stale[1..])).exists());
    let (o, took) = edwinclient(
        &["-n", "-c", "--socket", &up.socket, &note],
        None,
        &[("DISPLAY", &stale)],
    );
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    assert_eq!(o.status.code(), Some(1), "{err}");
    assert!(
        err.contains("edwinclient: cannot open a window: cannot reach the display"),
        "{err}"
    );
    assert!(took < Duration::from_secs(1), "{took:?}");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(children_in(&dir), Vec::<i32>::new(), "a frame was left");

    // What fails only in the frame, once detached (a -f NAME that is no command, known once edwind's init has run),
    // is in its log: the caller saw 0, the frame ends with 1, and its standard error was appended to edwin.log.
    let log = dir.join("state/edwin/edwin.log");
    let (o, took) = edwinclient(
        &[
            "-n",
            "-c",
            "-f",
            "no-such-command-xyz",
            "--socket",
            &up.socket,
            &note,
        ],
        None,
        &[],
    );
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    assert_eq!(o.status.code(), Some(0), "{err}");
    assert!(took < Duration::from_secs(1), "{took:?}");
    let frames = children_in(&dir);
    assert_eq!(frames.len(), 1, "the frame, the one child left: {frames:?}");
    let mut frame = Pid(frames[0]);
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut st = 0;
    // SAFETY: a wait for the frame, this test's child, without blocking.
    while unsafe { libc::waitpid(frame.0, &mut st, libc::WNOHANG) } != frame.0 {
        assert!(Instant::now() < deadline, "the frame did not leave");
        std::thread::sleep(Duration::from_millis(50));
    }
    frame.0 = 0;
    assert!(
        libc::WIFEXITED(st) && libc::WEXITSTATUS(st) == 1,
        "the frame's status: {st}"
    );
    let said = std::fs::read_to_string(&log).unwrap_or_default();
    if said.contains("cannot open a window") {
        skipped("no-wait", &format!("no window here: {said}"));
        return;
    }
    assert!(
        said.contains("edwinclient: no-such-command-xyz is not a command"),
        "the frame's log: {said}"
    );
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&log).unwrap().permissions())
            & 0o777,
        0o600
    );
    // The next frame's first draw is its own.
    std::fs::remove_file(&log).unwrap();

    // A descriptor of the caller's that is not close-on-exec, as a caller's leaked pipe would be.
    let mut fds = [0; 2];
    // SAFETY: pipe2 into a two-element array.
    assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
    let args = [
        "-n",
        "-c",
        "--title",
        "no-wait",
        "--socket",
        &up.socket,
        &note,
    ];
    let (o, took) = edwinclient(&args, Some(fds[1]), &[]);
    // SAFETY: the write end, which the test has no more use for.
    unsafe { libc::close(fds[1]) };
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    assert_eq!(o.status.code(), Some(0), "{err}");
    assert!(took < Duration::from_secs(1), "edwinclient -n took {took:?}");
    assert!(o.stdout.is_empty(), "{:?}", o.stdout);
    let frames = children_in(&dir);
    assert_eq!(frames.len(), 1, "the frame, the one child left: {frames:?}");
    let mut frame = Pid(frames[0]);
    let pid = frame.0;
    // Nothing holds the pipe's write end now: its read end is at its end at once.
    let mut p = libc::pollfd {
        fd: fds[0],
        events: libc::POLLIN,
        revents: 0,
    };
    let mut b = [0u8; 1];
    // SAFETY: poll of one descriptor, a read into a buffer of its size (only once poll says it will not block), and
    // the close of the test's own.
    let (n, got) = unsafe {
        let n = libc::poll(&mut p, 1, 2000);
        let got = if n == 1 {
            libc::read(fds[0], b.as_mut_ptr().cast(), 1)
        } else {
            -1
        };
        libc::close(fds[0]);
        (n, got)
    };
    assert!(
        n == 1 && got == 0,
        "the frame holds the caller's descriptor (poll {n}, read {got})"
    );

    let deadline = Instant::now() + Duration::from_secs(20);
    let win = loop {
        let mut st = 0;
        // SAFETY: a wait for the frame, this test's child, without blocking.
        if unsafe { libc::waitpid(pid, &mut st, libc::WNOHANG) } == pid {
            frame.0 = 0;
            // The -f frame above had a window, so this one should have: why it ended is in its log.
            panic!(
                "the frame ended ({st}) before its window appeared: {}",
                std::fs::read_to_string(&log).unwrap_or_default()
            );
        }
        assert!(Instant::now() < deadline, "the window did not appear");
        if let Some(w) = d.xdo(&["search", "--name", "^no-wait$"]).lines().next() {
            break w.to_string();
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    while !std::fs::read_to_string(&log)
        .unwrap_or_default()
        .contains("startup first draw")
    {
        assert!(Instant::now() < deadline, "the frame did not draw");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        d.prop(&win, "_NET_WM_PID"),
        format!("_NET_WM_PID(CARDINAL) = {pid}"),
        "the window is the frame's"
    );
    assert_eq!(d.prop(&win, "WM_CLASS"), WM_CLASS);
    let stat = proc_stat(pid);
    assert_eq!(
        stat[1],
        std::process::id().to_string(),
        "nothing between the frame and its caller"
    );
    assert_eq!(stat[3], pid.to_string(), "the frame leads a session of its own");
    assert_eq!(stat[4], "0", "the frame has no controlling terminal");
    // Standard input and output are /dev/null, and standard error is its log.
    let log_at = log.canonicalize().unwrap();
    for (fd, at) in [(0, Path::new("/dev/null")), (1, Path::new("/dev/null")), (2, &log_at)] {
        assert_eq!(
            std::fs::read_link(format!("/proc/{pid}/fd/{fd}")).unwrap(),
            at,
            "descriptor {fd}"
        );
    }
    // The window stays, and is a frame of edwind.
    d.xdo(&["mousemove", "300", "300"]);
    d.xdo(&["windowfocus", &win]);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(d.xdo(&["search", "--name", "^no-wait$"]), win);
    d.xdo(&["type", "--delay", "20", "Gotyped without waiting"]);
    d.xdo(&["key", "Escape"]);
    std::thread::sleep(Duration::from_millis(300));
    d.xdo(&["type", "--delay", "20", ":wq"]);
    d.xdo(&["key", "Return"]);
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut st = 0;
    // SAFETY: as above.
    while unsafe { libc::waitpid(pid, &mut st, libc::WNOHANG) } != pid {
        assert!(Instant::now() < deadline, "the frame did not leave");
        std::thread::sleep(Duration::from_millis(50));
    }
    frame.0 = 0;
    assert!(
        libc::WIFEXITED(st) && libc::WEXITSTATUS(st) == 0,
        "the frame's status: {st}"
    );
    assert_eq!(children_in(&dir), Vec::<i32>::new(), "something was left");
    assert_eq!(
        up.finish(),
        r##"{"server":"# Shared page\ntyped without waiting\n","disk":"# Shared page\ntyped without waiting\n","opened":["a.md"]}"##
    );
}

/// The window's WM_CLASS is edwin's, and --title NAME (or --title=NAME) is its title for good, as compositor rules
/// match a scratch or calculator frame by the two; without it the title follows the frame. Wayland's app_id,
/// set from the same name, has no compositor to show it here.
#[test]
fn the_window_is_edwin_and_title_names_it_for_good() {
    let Some(d) = Display::start("identity") else {
        return;
    };
    let dir = workdir("identity");
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    let Some(mut e) = Edwin::open(&d, &dir, &["a.txt"], &[]) else {
        return;
    };
    assert_eq!(d.prop(&e.win, "WM_CLASS"), WM_CLASS);
    assert_eq!(
        d.prop(&e.win, "_NET_WM_NAME"),
        r#"_NET_WM_NAME(UTF8_STRING) = "a.txt - Edwin""#
    );
    e.typed(":q").key("Return");
    assert_eq!(e.exit(), 0, "{}", e.stderr());
    for flag in [
        &["--title", "org-scratch"][..],
        &["--title=org-scratch"][..],
    ] {
        let args = [flag, &["a.txt"]].concat();
        let Some(mut e) = Edwin::open_program(&d, &dir, BIN, "--gui", &args, &[], "^org-scratch$")
        else {
            return;
        };
        assert_eq!(d.prop(&e.win, "WM_CLASS"), WM_CLASS, "{flag:?}");
        // The frame draws, which without --title names the window after the buffer, and the title stays.
        e.typed("Atwo").key("Escape");
        e.settle();
        for (prop, value) in [
            (
                "_NET_WM_NAME",
                r#"_NET_WM_NAME(UTF8_STRING) = "org-scratch""#,
            ),
            ("WM_NAME", r#"WM_NAME(STRING) = "org-scratch""#),
        ] {
            assert_eq!(d.prop(&e.win, prop), value, "{flag:?}");
        }
        e.typed(":wq").key("Return");
        assert_eq!(e.exit(), 0, "{}", e.stderr());
    }
    assert_eq!(read(dir.join("a.txt")), "onetwotwo\n");
}

/// The budget (docs/steps.md, step DT2): from a key's arrival to the frame's present, on a 200x50 window full of
/// source text, p50 at most 10 ms and p99 at most 25 ms, on the software renderer. Timing on a shared machine is
/// noisy, so this runs on request and alone: cargo test --release -- --ignored latency
#[test]
#[ignore]
fn keystroke_to_screen_latency_budget() {
    let Some(d) = Display::start("latency") else {
        return;
    };
    let dir = workdir("latency");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/display.ts");
    std::fs::copy(src, dir.join("big.js")).unwrap();
    let lat = dir.join("latency.log");
    let lat_s = lat.display().to_string();
    let env = [("EDWIN_GUI_LATENCY_LOG", lat_s.as_str())];
    let Some(mut e) = Edwin::open(&d, &dir, &["--geometry=200x50", "big.js"], &env) else {
        return;
    };
    for _ in 0..40 {
        e.key("j");
    }
    e.key("o")
        .typed("const answer = 42; // typed in the window to measure its latency")
        .key("Escape");
    for _ in 0..20 {
        e.key("ctrl+d");
    }
    e.settle();
    e.typed(":q!").key("Return");
    assert_eq!(e.exit(), 0);
    let mut us: Vec<u64> = read(&lat)
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect();
    us.sort_unstable();
    // Keys that arrive before one present share it, so there are fewer measurements than keys.
    assert!(us.len() > 50, "{} presents measured", us.len());
    let at = |q: f64| us[((us.len() as f64 * q) as usize).min(us.len() - 1)];
    let (p50, p99) = (at(0.5), at(0.99));
    eprintln!(
        "{} keys: p50 {p50} us, p99 {p99} us, max {} us",
        us.len(),
        us[us.len() - 1]
    );
    assert!(
        p50 <= 10_000 && p99 <= 25_000,
        "over budget: p50 {p50} us, p99 {p99} us"
    );
}
