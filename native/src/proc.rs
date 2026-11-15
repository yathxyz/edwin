//! Child processes, for the frame's TypeScript (and through it compile, grep, shell commands, git, jj, formatters
//! and language servers): one implementation for every area.
//!
//! A child is an argv run as it is, never through a shell. Its standard input, output and error are pipes (output
//! and error one pipe when merged) that sys::wait polls with everything else, so a child never blocks the loop:
//! what it writes reaches JS as text as it comes, what JS writes to it is queued and written as the pipe takes it.
//! Its exit is seen through SIGCHLD on the signal pipe, and each child is reaped by its own pid (never
//! waitpid(-1), which would take the ssh and edwin-daemon children std::process waits for). Its exit reaches JS
//! after everything it wrote. At most MAX_CHILDREN run at once; when the program ends, every one still running
//! is ended (TERM, then KILL), and the kernel kills each one whose parent dies some other way.
//!
//! The child starts in a session of its own (setsid), so it has no controlling terminal (a git or ssh that would
//! ask on /dev/tty fails instead of fighting the raw terminal Edwin holds) and a signal sent to its process group
//! reaches what it started too; it inherits no descriptor but its three.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child as StdChild, Command, Stdio};
use std::time::{Duration, Instant};

/// Children running at once (counted until reaped): a spawn past it is refused.
pub const MAX_CHILDREN: usize = 64;
/// Bytes queued for a child's standard input that it has not taken yet: a write past it is refused.
const STDIN_MAX: usize = 64 << 20;
/// From TERM to KILL, at a timeout and when the program ends.
const GRACE: Duration = Duration::from_millis(500);
/// One read of a pipe; a busy child is read one chunk per turn of the loop, so it never starves the rest.
const CHUNK: usize = 65536;
/// Reads of a reaped child's pipes before its exit is reported: what it wrote before it exited (a pipe holds at
/// most 1 MiB), not what something it started goes on writing.
const DRAIN_READS: usize = 32;

/// What to run and how.
#[derive(Default)]
pub struct Spec {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    /// Changes to the inherited environment: a value set, None removed.
    pub env: Vec<(String, Option<String>)>,
    /// Ended (TERM, then KILL after GRACE) when it runs longer.
    pub timeout: Option<Duration>,
    /// Output and error together, in bytes: past it the child is killed and the rest is not read.
    pub max_bytes: Option<usize>,
    /// Bytes that are not UTF-8 become U+FFFD (git's output: file names and contents in any encoding). Without
    /// it, such output ends the child with an error, so nothing is ever written back changed.
    pub lossy: bool,
    /// Standard error into the output pipe, interleaved as written (compile).
    pub merge: bool,
}

/// How a child ended.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Exit {
    /// Its exit status, or None when a signal ended it.
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub truncated: bool,
    /// Why Edwin stopped it or stopped reading it (output that is not UTF-8).
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Out(u32, String),
    Err(u32, String),
    Exit(u32, Exit),
}

/// Which of a child's pipes a polled descriptor is.
#[derive(Clone, Copy, PartialEq)]
pub enum Pipe {
    In,
    Out,
    Err,
}

#[derive(Default)]
struct Stream {
    file: Option<File>,
    /// An unfinished UTF-8 sequence, kept for the next read.
    carry: Vec<u8>,
}

struct Proc {
    child: StdChild,
    argv: Vec<String>,
    stdin: Option<File>,
    inq: Vec<u8>,
    /// Close standard input once the queue is written.
    close_stdin: bool,
    out: Stream,
    err: Stream,
    bytes: usize,
    max_bytes: Option<usize>,
    lossy: bool,
    /// The timeout; after it has sent TERM, when KILL follows.
    deadline: Option<Instant>,
    terminating: bool,
    timed_out: bool,
    truncated: bool,
    error: Option<String>,
}

#[derive(Default)]
struct State {
    procs: BTreeMap<u32, Proc>,
    next: u32,
}

thread_local! {
    static ST: RefCell<State> = RefCell::new(State::default());
}

fn os_msg(e: &std::io::Error) -> String {
    let m = e.to_string();
    m.split(" (os error").next().unwrap_or(&m).to_string()
}

fn pipe() -> std::io::Result<(File, File)> {
    let mut fds = [0; 2];
    // SAFETY: pipe2 fills the array; each descriptor is then owned by one File.
    unsafe {
        if libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])))
    }
}

fn nonblocking(f: &File) {
    // SAFETY: fcntl on a descriptor we own.
    unsafe {
        let fl = libc::fcntl(f.as_raw_fd(), libc::F_GETFL);
        libc::fcntl(f.as_raw_fd(), libc::F_SETFL, fl | libc::O_NONBLOCK);
    }
}

/// Start ARGV. Err says why it could not run (no such program, a directory that is not there, too many).
pub fn spawn(spec: Spec) -> Result<u32, String> {
    let Some(program) = spec.argv.first() else {
        return Err("no program to run".into());
    };
    if count() >= MAX_CHILDREN {
        return Err(format!(
            "too many processes: at most {MAX_CHILDREN} run at once"
        ));
    }
    for (k, _) in &spec.env {
        if k.is_empty() || k.contains(['=', '\0']) {
            return Err(format!("not an environment variable's name: {k:?}"));
        }
    }
    let err = |e: std::io::Error| format!("cannot run {program}: {}", os_msg(&e));
    let (in_r, in_w) = pipe().map_err(err)?;
    let (out_r, out_w) = pipe().map_err(err)?;
    let mut cmd = Command::new(program);
    cmd.args(&spec.argv[1..]);
    if let Some(d) = &spec.cwd {
        cmd.current_dir(d);
    }
    for (k, v) in &spec.env {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    cmd.stdin(Stdio::from(in_r));
    let err_r = if spec.merge {
        cmd.stderr(Stdio::from(out_w.try_clone().map_err(err)?));
        None
    } else {
        let (r, w) = pipe().map_err(err)?;
        cmd.stderr(Stdio::from(w));
        Some(r)
    };
    cmd.stdout(Stdio::from(out_w));
    // SAFETY: getpid before the fork; in the child only async-signal-safe calls (setsid, prctl, getppid, signal,
    // close_range), as between fork and exec they must be.
    let parent = unsafe { libc::getpid() };
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Killed when Edwin dies without ending it (a crash, an abort, SIGKILL); gone already: not run.
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            if libc::getppid() != parent {
                return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
            }
            // Edwin ignores SIGPIPE, and an ignored signal stays ignored across exec.
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            // Every descriptor past the three is closed at the exec (std's own pipe for a failed exec too, which is
            // close-on-exec already, so marked rather than closed: it still reports the failure).
            if libc::close_range(3, u32::MAX, libc::CLOSE_RANGE_CLOEXEC as i32) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn().map_err(err)?;
    // The child's ends, which the parent must not hold (or no EOF ever comes), go with the command.
    drop(cmd);
    for f in [Some(&in_w), Some(&out_r), err_r.as_ref()]
        .into_iter()
        .flatten()
    {
        nonblocking(f);
    }
    let p = Proc {
        child,
        argv: spec.argv,
        stdin: Some(in_w),
        inq: Vec::new(),
        close_stdin: false,
        out: Stream {
            file: Some(out_r),
            carry: Vec::new(),
        },
        err: Stream {
            file: err_r,
            carry: Vec::new(),
        },
        bytes: 0,
        max_bytes: spec.max_bytes,
        lossy: spec.lossy,
        deadline: spec.timeout.and_then(|t| Instant::now().checked_add(t)),
        terminating: false,
        timed_out: false,
        truncated: false,
        error: None,
    };
    Ok(ST.with(|st| {
        let mut st = st.borrow_mut();
        st.next += 1;
        let id = st.next;
        st.procs.insert(id, p);
        id
    }))
}

impl Proc {
    /// SIG to the child's process group (it leads one: setsid), while the child is not reaped, so its pid
    /// cannot have been given to another process.
    fn signal(&self, sig: libc::c_int) -> bool {
        // SAFETY: kill(2) on the group of a child we have not reaped.
        unsafe { libc::kill(-(self.child.id() as libc::pid_t), sig) == 0 }
    }
    /// Write what the pipe takes now; a child that closed its input (EPIPE) gets no more.
    fn flush(&mut self) {
        let Some(f) = self.stdin.as_mut() else {
            self.inq.clear();
            return;
        };
        while !self.inq.is_empty() {
            match f.write(&self.inq) {
                Ok(0) => break,
                Ok(k) => {
                    self.inq.drain(..k);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        if !self.inq.is_empty() || self.close_stdin {
            self.inq.clear();
            self.stdin = None;
        }
    }
    /// Stop reading it and end it: its output went past max_bytes, or is not UTF-8.
    fn stop(&mut self) {
        self.signal(libc::SIGKILL);
        self.out = Stream::default();
        self.err = Stream::default();
        self.stdin = None;
        self.inq.clear();
    }
    /// Read up to READS chunks of one pipe, as events. EOF closes it.
    fn pull(&mut self, id: u32, which: Pipe, reads: usize, ev: &mut Vec<Event>) {
        for _ in 0..reads {
            let s = if which == Pipe::Err {
                &mut self.err
            } else {
                &mut self.out
            };
            let Some(f) = s.file.as_mut() else { return };
            let mut b = vec![0u8; CHUNK];
            let k = match f.read(&mut b) {
                Ok(k) => k,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => 0,
            };
            if k == 0 {
                s.file = None;
                let rest = std::mem::take(&mut s.carry);
                if !rest.is_empty() {
                    // It ended inside a UTF-8 sequence.
                    if self.lossy {
                        self.emit(id, which, "\u{fffd}".into(), ev);
                    } else {
                        self.not_utf8();
                    }
                }
                return;
            }
            let mut k = k;
            if let Some(m) = self.max_bytes {
                let room = m.saturating_sub(self.bytes);
                if k > room {
                    k = room;
                    self.truncated = true;
                }
            }
            self.bytes += k;
            let s = if which == Pipe::Err {
                &mut self.err
            } else {
                &mut self.out
            };
            let (text, bad) = if self.lossy {
                (crate::sys::decode(&mut s.carry, &b[..k]), false)
            } else {
                decode_strict(&mut s.carry, &b[..k])
            };
            self.emit(id, which, text, ev);
            if bad {
                self.not_utf8();
                return;
            }
            if self.truncated {
                // An unfinished sequence at the cut is dropped with the rest.
                self.stop();
                return;
            }
        }
    }
    fn not_utf8(&mut self) {
        self.error = Some("its output is not UTF-8 text".into());
        self.stop();
    }
    fn emit(&self, id: u32, which: Pipe, text: String, ev: &mut Vec<Event>) {
        if text.is_empty() {
            return;
        }
        ev.push(if which == Pipe::Err {
            Event::Err(id, text)
        } else {
            Event::Out(id, text)
        });
    }
}

/// Bytes to text, a sequence split between reads kept for the next. true: bytes that are not UTF-8 (the text
/// is what came before them).
fn decode_strict(carry: &mut Vec<u8>, bytes: &[u8]) -> (String, bool) {
    carry.extend_from_slice(bytes);
    match std::str::from_utf8(carry) {
        Ok(s) => {
            let t = s.to_owned();
            carry.clear();
            (t, false)
        }
        Err(e) => {
            let good = e.valid_up_to();
            let t = String::from_utf8_lossy(&carry[..good]).into_owned();
            carry.drain(..good);
            (t, e.error_len().is_some())
        }
    }
}

/// Queue TEXT for the child's standard input. false: its input is closed (or it was reaped).
pub fn write(id: u32, bytes: &[u8]) -> Result<bool, String> {
    ST.with(|st| {
        let mut st = st.borrow_mut();
        let Some(p) = st.procs.get_mut(&id) else {
            return Ok(false);
        };
        if p.stdin.is_none() || p.close_stdin {
            return Ok(false);
        }
        if p.inq.len() + bytes.len() > STDIN_MAX {
            return Err(format!(
                "process {id} has not taken the {} MiB already sent to it",
                STDIN_MAX >> 20
            ));
        }
        p.inq.extend_from_slice(bytes);
        p.flush();
        Ok(true)
    })
}

/// Close the child's standard input once what was written reaches it.
pub fn close_stdin(id: u32) {
    ST.with(|st| {
        if let Some(p) = st.borrow_mut().procs.get_mut(&id) {
            p.close_stdin = true;
            p.flush();
        }
    })
}

/// A signal by its name (TERM or SIGTERM), among those a user sends.
pub fn signal_number(name: &str) -> Option<libc::c_int> {
    Some(match name.strip_prefix("SIG").unwrap_or(name) {
        "TERM" => libc::SIGTERM,
        "KILL" => libc::SIGKILL,
        "INT" => libc::SIGINT,
        "HUP" => libc::SIGHUP,
        "QUIT" => libc::SIGQUIT,
        "STOP" => libc::SIGSTOP,
        "CONT" => libc::SIGCONT,
        "USR1" => libc::SIGUSR1,
        "USR2" => libc::SIGUSR2,
        _ => return None,
    })
}

fn signal_name(sig: libc::c_int) -> String {
    match sig {
        libc::SIGHUP => "HUP",
        libc::SIGINT => "INT",
        libc::SIGQUIT => "QUIT",
        libc::SIGILL => "ILL",
        libc::SIGTRAP => "TRAP",
        libc::SIGABRT => "ABRT",
        libc::SIGBUS => "BUS",
        libc::SIGFPE => "FPE",
        libc::SIGKILL => "KILL",
        libc::SIGUSR1 => "USR1",
        libc::SIGSEGV => "SEGV",
        libc::SIGUSR2 => "USR2",
        libc::SIGPIPE => "PIPE",
        libc::SIGALRM => "ALRM",
        libc::SIGTERM => "TERM",
        _ => return format!("SIG{sig}"),
    }
    .into()
}

/// SIG to the child ID and what it started. false: no such child running.
pub fn kill(id: u32, sig: libc::c_int) -> bool {
    ST.with(|st| st.borrow().procs.get(&id).is_some_and(|p| p.signal(sig)))
}

/// The children not yet reported ended: id, pid, argv.
pub fn list() -> Vec<(u32, u32, Vec<String>)> {
    ST.with(|st| {
        st.borrow()
            .procs
            .iter()
            .map(|(&id, p)| (id, p.child.id(), p.argv.clone()))
            .collect()
    })
}

pub fn count() -> usize {
    ST.with(|st| st.borrow().procs.len())
}

/// How long until a child's timeout (or its KILL) is due, for the loop's sleep.
pub fn until_deadline() -> Option<Duration> {
    let now = Instant::now();
    ST.with(|st| {
        st.borrow()
            .procs
            .values()
            .filter_map(|p| p.deadline)
            .min()
            .map(|d| d.saturating_duration_since(now))
    })
}

/// The children's pipes for poll(2), each with what it is: output and error to read, input while bytes wait.
pub fn add_fds(fds: &mut Vec<libc::pollfd>) -> Vec<(u32, Pipe)> {
    let mut tags = Vec::new();
    ST.with(|st| {
        for (&id, p) in st.borrow().procs.iter() {
            let mut add = |f: Option<&File>, events: i16, which: Pipe| {
                if let Some(f) = f {
                    fds.push(libc::pollfd {
                        fd: f.as_raw_fd(),
                        events,
                        revents: 0,
                    });
                    tags.push((id, which));
                }
            };
            if !p.inq.is_empty() {
                add(p.stdin.as_ref(), libc::POLLOUT, Pipe::In);
            }
            add(p.out.file.as_ref(), libc::POLLIN, Pipe::Out);
            add(p.err.file.as_ref(), libc::POLLIN, Pipe::Err);
        }
    });
    tags
}

/// After poll: read and write what is ready, end the children past their timeout, reap the ones that exited
/// (each by its pid, every turn: a SIGCHLD only wakes the loop) and report each one's exit after its output.
pub fn service(fds: &[libc::pollfd], tags: &[(u32, Pipe)], ev: &mut Vec<Event>) {
    ST.with(|st| {
        let mut st = st.borrow_mut();
        for (pfd, &(id, which)) in fds.iter().zip(tags) {
            if pfd.revents == 0 {
                continue;
            }
            let Some(p) = st.procs.get_mut(&id) else {
                continue;
            };
            match which {
                Pipe::In => p.flush(),
                _ => p.pull(id, which, 1, ev),
            }
        }
        let now = Instant::now();
        let ids: Vec<u32> = st.procs.keys().copied().collect();
        for id in ids {
            let p = st.procs.get_mut(&id).unwrap();
            if p.deadline.is_some_and(|d| d <= now) {
                if p.terminating {
                    p.signal(libc::SIGKILL);
                    p.deadline = None;
                } else {
                    p.timed_out = true;
                    p.terminating = true;
                    p.signal(libc::SIGTERM);
                    p.deadline = Some(now + GRACE);
                }
            }
            let status = match p.child.try_wait() {
                Ok(None) => continue,
                Ok(Some(st)) => Some(st),
                // Reaped by someone else (nothing here does): its status is lost.
                Err(_) => None,
            };
            p.pull(id, Pipe::Out, DRAIN_READS, ev);
            p.pull(id, Pipe::Err, DRAIN_READS, ev);
            for which in [Pipe::Out, Pipe::Err] {
                let s = if which == Pipe::Err {
                    &mut p.err
                } else {
                    &mut p.out
                };
                // Still open: something it started holds the pipe. Its own output is all read; an unfinished
                // sequence at the end is its last.
                if s.file.take().is_some() && !std::mem::take(&mut s.carry).is_empty() {
                    if p.lossy {
                        p.emit(id, which, "\u{fffd}".into(), ev);
                    } else {
                        p.error = Some("its output is not UTF-8 text".into());
                    }
                }
            }
            let mut exit = Exit {
                code: status.and_then(|s| s.code()),
                signal: status.and_then(|s| s.signal()).map(signal_name),
                timed_out: p.timed_out,
                truncated: p.truncated,
                error: p.error.take(),
            };
            if status.is_none() {
                exit.error = Some("its exit status was lost".into());
            }
            st.procs.remove(&id);
            ev.push(Event::Exit(id, exit));
        }
    })
}

/// End every child (the program ends): TERM to each one's process group, KILL after GRACE to what is left, and
/// each reaped. Bounded: a child that will not die (stuck in the kernel) is left to init after another GRACE.
pub fn kill_all() {
    ST.with(|st| {
        let mut st = st.borrow_mut();
        for sig in [libc::SIGTERM, libc::SIGKILL] {
            for p in st.procs.values() {
                p.signal(sig);
            }
            let end = Instant::now() + GRACE;
            loop {
                st.procs
                    .retain(|_, p| matches!(p.child.try_wait(), Ok(None)));
                if st.procs.is_empty() || Instant::now() >= end {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        st.procs.clear();
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sys;

    /// The tests share the signal pipe (one per process): one at a time, so none takes another's wake-up.
    pub(crate) fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        static SIGNALS: std::sync::Once = std::sync::Once::new();
        SIGNALS.call_once(sys::install_signals);
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn run(argv: &[&str], f: impl FnOnce(&mut Spec)) -> u32 {
        let mut spec = Spec {
            argv: argv.iter().map(|s| s.to_string()).collect(),
            ..Spec::default()
        };
        f(&mut spec);
        spawn(spec).unwrap()
    }

    /// Run the loop until ID's exit (at most LIMIT): its output, error and exit.
    fn finish(id: u32, limit: Duration) -> (String, String, Exit) {
        let (mut out, mut err) = (String::new(), String::new());
        let end = Instant::now() + limit;
        while Instant::now() < end {
            for e in sys::wait(100).procs {
                match e {
                    Event::Out(i, t) if i == id => out.push_str(&t),
                    Event::Err(i, t) if i == id => err.push_str(&t),
                    Event::Exit(i, x) if i == id => return (out, err, x),
                    _ => {}
                }
            }
        }
        panic!("process {id} did not end in {limit:?}: out {out:?} err {err:?}");
    }

    const LONG: Duration = Duration::from_secs(10);

    fn reaped(pid: u32) -> bool {
        // A zombie is still in /proc (state Z): only a reaped child is gone.
        !std::path::Path::new(&format!("/proc/{pid}")).exists()
    }

    #[test]
    fn echo_gives_its_output_then_its_exit() {
        let _g = serial();
        let id = run(&["echo", "hello", "wörld"], |_| {});
        let (out, err, x) = finish(id, LONG);
        assert_eq!(out, "hello wörld\n");
        assert_eq!(err, "");
        assert_eq!(
            x,
            Exit {
                code: Some(0),
                ..Exit::default()
            }
        );
        assert_eq!(count(), 0);
    }

    #[test]
    fn argv_is_never_a_shell_line() {
        let _g = serial();
        let id = run(&["echo", "$HOME; touch x", "`id`"], |_| {});
        assert_eq!(finish(id, LONG).0, "$HOME; touch x `id`\n");
    }

    #[test]
    fn error_status_cwd_env_and_merge() {
        let _g = serial();
        let id = run(&["ls", "/no/such/dir"], |_| {});
        let (out, err, x) = finish(id, LONG);
        assert_eq!(out, "");
        assert!(err.contains("/no/such/dir"), "{err}");
        assert_eq!(x.code, Some(2));
        let id = run(&["pwd"], |s| s.cwd = Some("/".into()));
        assert_eq!(finish(id, LONG).0, "/\n");
        std::env::set_var("EDWIN_PROC_TEST_GONE", "1");
        let id = run(&["env"], |s| {
            s.env = vec![
                ("EDWIN_PROC_TEST".into(), Some("a b".into())),
                ("EDWIN_PROC_TEST_GONE".into(), None),
            ]
        });
        let out = finish(id, LONG).0;
        assert!(out.lines().any(|l| l == "EDWIN_PROC_TEST=a b"), "{out}");
        assert!(!out.contains("EDWIN_PROC_TEST_GONE"), "{out}");
        let id = run(&["ls", "/", "/no/such/dir"], |s| s.merge = true);
        let (out, err, _) = finish(id, LONG);
        assert!(
            out.contains("/no/such/dir") && out.contains("proc"),
            "{out}"
        );
        assert_eq!(err, "");
    }

    #[test]
    fn a_program_that_cannot_run_is_refused_at_once() {
        let _g = serial();
        let e = spawn(Spec {
            argv: vec!["edwin-no-such-program".into()],
            ..Spec::default()
        })
        .unwrap_err();
        assert!(e.starts_with("cannot run edwin-no-such-program: "), "{e}");
        let e = spawn(Spec {
            argv: vec!["pwd".into()],
            cwd: Some("/no/such/dir".into()),
            ..Spec::default()
        })
        .unwrap_err();
        assert!(e.contains("No such file or directory"), "{e}");
        assert!(spawn(Spec::default()).is_err());
        let bad = Spec {
            argv: vec!["env".into()],
            env: vec![("A=B".into(), Some("c".into()))],
            ..Spec::default()
        };
        assert!(spawn(bad).is_err());
        assert_eq!(count(), 0);
    }

    #[test]
    fn stdin_is_written_as_the_child_takes_it_and_closed() {
        let _g = serial();
        let id = run(&["cat"], |_| {});
        assert!(write(id, b"line one\n").unwrap());
        // 8 MiB, far more than a pipe holds, queued at once while cat has read nothing: no write blocks.
        let big = vec![b'x'; 8 << 20];
        let t0 = Instant::now();
        assert!(write(id, &big).unwrap());
        assert!(t0.elapsed() < Duration::from_secs(1));
        close_stdin(id);
        assert!(!write(id, b"late").unwrap());
        let (out, _, x) = finish(id, LONG);
        assert_eq!(x.code, Some(0));
        assert_eq!(out.len(), 9 + (8 << 20));
        assert!(out.starts_with("line one\nxxx"));
    }

    #[test]
    fn kill_ends_the_child_and_what_it_started() {
        let _g = serial();
        // sh is the child here only to start a grandchild; the argv is still one program and its arguments.
        let id = run(&["sh", "-c", "sleep 30 & echo $!; wait"], |_| {});
        let mut grandchild = String::new();
        while !grandchild.ends_with('\n') {
            for e in sys::wait(100).procs {
                if let Event::Out(i, t) = e {
                    assert_eq!(i, id);
                    grandchild.push_str(&t);
                }
            }
        }
        let gpid: u32 = grandchild.trim().parse().unwrap();
        let pid = list()[0].1;
        assert_eq!(list()[0].2, ["sh", "-c", "sleep 30 & echo $!; wait"]);
        assert!(kill(id, signal_number("TERM").unwrap()));
        let (_, _, x) = finish(id, LONG);
        assert_eq!(x.code, None);
        assert_eq!(x.signal.as_deref(), Some("TERM"));
        assert!(reaped(pid));
        // The grandchild was in its group: it got TERM too (and init reaped it, or will).
        let end = Instant::now() + LONG;
        while std::fs::read_to_string(format!("/proc/{gpid}/stat"))
            .is_ok_and(|s| !s.contains(") Z "))
        {
            assert!(Instant::now() < end, "the grandchild still runs");
            std::thread::sleep(Duration::from_millis(10));
        }
        // Reaped: no signal reaches the pid again.
        assert!(!kill(id, libc::SIGKILL));
    }

    #[test]
    fn the_65th_spawn_is_refused() {
        let _g = serial();
        let ids: Vec<u32> = (0..MAX_CHILDREN)
            .map(|_| run(&["sleep", "30"], |_| {}))
            .collect();
        let e = spawn(Spec {
            argv: vec!["true".into()],
            ..Spec::default()
        })
        .unwrap_err();
        assert!(e.contains("too many processes"), "{e}");
        let pids: Vec<u32> = list().iter().map(|l| l.1).collect();
        kill_all();
        assert_eq!(count(), 0);
        assert!(pids.iter().all(|&p| reaped(p)));
        // Room again once they are gone.
        let id = run(&["true"], |_| {});
        assert_eq!(finish(id, LONG).2.code, Some(0));
        assert!(!ids.contains(&id));
    }

    #[test]
    fn no_zombie_after_exit() {
        let _g = serial();
        let id = run(&["true"], |_| {});
        let pid = list()[0].1;
        let (_, _, x) = finish(id, LONG);
        assert_eq!(x.code, Some(0));
        assert!(reaped(pid));
        assert!(list().is_empty());
        // Nothing left that waitpid could take.
        // SAFETY: waitpid on our own (reaped) child.
        let r = unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) };
        assert_eq!(r, -1);
    }

    #[test]
    fn the_timeout_fires_and_kill_follows_a_child_that_ignores_term() {
        let _g = serial();
        let t0 = Instant::now();
        let id = run(&["sleep", "30"], |s| {
            s.timeout = Some(Duration::from_millis(200))
        });
        let (_, _, x) = finish(id, LONG);
        assert!(x.timed_out);
        assert_eq!(x.signal.as_deref(), Some("TERM"));
        assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
        // The loop slept until the deadline by itself: nothing else woke it.
        let t0 = Instant::now();
        let id = run(
            &["sh", "-c", "trap '' TERM; while :; do sleep 0.05; done"],
            |s| s.timeout = Some(Duration::from_millis(100)),
        );
        let (_, _, x) = finish(id, LONG);
        assert!(x.timed_out);
        assert_eq!(x.signal.as_deref(), Some("KILL"));
        assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
    }

    #[test]
    fn max_bytes_cuts_the_output_and_ends_the_child() {
        let _g = serial();
        let id = run(&["yes"], |s| s.max_bytes = Some(10_000));
        let (out, _, x) = finish(id, LONG);
        assert_eq!(out.len(), 10_000);
        assert!(x.truncated);
        assert_eq!(x.signal.as_deref(), Some("KILL"));
    }

    #[test]
    fn output_that_is_not_utf8_is_an_error_unless_lossy() {
        let _g = serial();
        let id = run(&["printf", "ok\\377\\376 rest"], |_| {});
        let (out, _, x) = finish(id, LONG);
        assert_eq!(out, "ok");
        assert_eq!(x.error.as_deref(), Some("its output is not UTF-8 text"));
        let id = run(&["printf", "ok\\377 rest \\303"], |s| s.lossy = true);
        let (out, _, x) = finish(id, LONG);
        assert_eq!(out, "ok\u{fffd} rest \u{fffd}");
        assert_eq!(
            x,
            Exit {
                code: Some(0),
                ..Exit::default()
            }
        );
        // A sequence split between two writes is one character.
        let id = run(
            &["sh", "-c", "printf '\\303'; sleep 0.1; printf '\\251'"],
            |_| {},
        );
        let (out, _, x) = finish(id, LONG);
        assert_eq!(out, "é");
        assert_eq!(x.error, None);
    }

    #[test]
    fn the_child_inherits_only_its_three_descriptors_and_no_terminal() {
        let _g = serial();
        // A descriptor of ours that is not close-on-exec.
        // SAFETY: open and later close of our own descriptor.
        let fd = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) };
        assert!(fd > 2);
        let id = run(&["ls", "/proc/self/fd"], |_| {});
        let (out, _, _) = finish(id, LONG);
        unsafe { libc::close(fd) };
        // ls's own descriptor on the directory it reads is the fourth.
        let fds: Vec<&str> = out.lines().collect();
        assert!(fds.len() <= 4 && fds[..3] == ["0", "1", "2"], "{fds:?}");
        // Its own session, so no controlling terminal; SIGPIPE not ignored (bit 13 of SigIgn).
        let id = run(&["cat", "/proc/self/stat", "/proc/self/status"], |_| {});
        let (out, _, _) = finish(id, LONG);
        let stat: Vec<&str> = out
            .lines()
            .next()
            .unwrap()
            .rsplit(") ")
            .next()
            .unwrap()
            .split(' ')
            .collect();
        let (pid, sid, tty) = (out.split(' ').next().unwrap(), stat[3], stat[4]);
        assert_eq!(pid, sid, "the child leads its own session");
        assert_eq!(tty, "0", "no controlling terminal");
        let ign = out
            .lines()
            .find_map(|l| l.strip_prefix("SigIgn:"))
            .unwrap()
            .trim();
        assert_eq!(
            u64::from_str_radix(ign, 16).unwrap() & (1 << 12),
            0,
            "SigIgn {ign}"
        );
    }

    #[test]
    fn kill_all_ends_every_child_within_its_bound() {
        let _g = serial();
        run(&["sleep", "30"], |_| {});
        run(
            &["sh", "-c", "trap '' TERM; while :; do sleep 0.05; done"],
            |_| {},
        );
        let pids: Vec<u32> = list().iter().map(|l| l.1).collect();
        let t0 = Instant::now();
        kill_all();
        assert!(t0.elapsed() < Duration::from_secs(2));
        assert_eq!(count(), 0);
        assert!(pids.iter().all(|&p| reaped(p)));
    }
}
