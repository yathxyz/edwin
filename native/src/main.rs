//! edwin: Edwin's JavaScript core on embedded V8, in a terminal (DT1) or a window (DT2, `--gui`); under the name
//! edwinclient, a frame of an edwind, as emacsclient is of an Emacs daemon.
//!
//! The Rust side is the host's floor: the files, the terminal or the window, signals, edwind's socket and the
//! event loop. Everything Edwin is runs as JavaScript: native/js/prelude.ts, host-native.ts, term.ts and
//! main.ts, which loads the unchanged core from src. All of it is compiled into the binary, with the
//! shipped Scheme.
//!
//! The loop: poll the terminal (or pump the window's events), the signal pipe and the sockets; hand what arrived
//! to JS; run due timers; run microtasks; write or draw what JS drew; sleep until the next input or timer.

mod bridge;
#[cfg(feature = "gui")]
mod gui;
mod natives;
mod snapshot;
mod sources;
mod sys;

use std::path::{Path, PathBuf};
use std::time::Instant;

/// ICU's data, for V8's \p{...} classes and Unicode case folding (build.rs finds it).
#[repr(C, align(16))]
struct Aligned<T: ?Sized>(T);
static ICU_DATA: &Aligned<[u8]> =
    &Aligned(*include_bytes!(concat!(env!("OUT_DIR"), "/icudtl.dat")));
/// The startup snapshot build.rs made: the core loaded and booted with the shipped Scheme.
static SNAPSHOT: &Aligned<[u8]> =
    &Aligned(*include_bytes!(concat!(env!("OUT_DIR"), "/snapshot.bin")));

fn main() {
    // Every reading of the command line after this one takes it as UTF-8.
    if let Some(a) = std::env::args_os().find(|a| a.to_str().is_none()) {
        eprintln!("{}: not UTF-8: {}", name(), a.to_string_lossy());
        std::process::exit(2);
    }
    // `edwin --daemon` (in the background) and `edwin --fg-daemon` start the user's edwind, as Emacs's do: through
    // edwin-daemon beside this program, which the package installs with edwind.
    if let Some(a) = std::env::args()
        .nth(1)
        .filter(|a| !is_client() && (a == "--daemon" || a == "--fg-daemon"))
    {
        match daemon_program() {
            Some(d) => {
                let mut cmd = std::process::Command::new(d);
                if a == "--fg-daemon" {
                    cmd.arg("--fg");
                }
                // The rest of the line, which edwin-daemon checks before anything: it refuses a FILE and
                // an unknown option with status 2, and answers --help.
                cmd.args(std::env::args().skip(2));
                let err = std::os::unix::process::CommandExt::exec(&mut cmd);
                eprintln!("edwin: cannot start edwin-daemon: {err}");
            }
            None => eprintln!("edwin: {a} needs edwin-daemon beside edwin (the Nix package installs it with edwind)"),
        }
        std::process::exit(1);
    }
    // V8 runs on a thread whose stack holds the Scheme evaluator's depth cap (R4.34; edwind sizes it alike).
    let code = std::thread::Builder::new()
        .name("edwin".into())
        .stack_size(96 << 20)
        .spawn(run)
        .expect("start the V8 thread")
        .join()
        .unwrap_or(70);
    std::process::exit(code);
}

/// Whether the program runs as edwinclient: its name, as the package's link bin/edwinclient to edwin gives it.
fn is_client() -> bool {
    std::env::args_os()
        .next()
        .is_some_and(|a| Path::new(&a).file_name() == Some("edwinclient".as_ref()))
}

fn name() -> &'static str {
    if is_client() {
        "edwinclient"
    } else {
        "edwin"
    }
}

/// edwin-daemon beside this program (the real file: a link named edwinclient leads here too).
fn daemon_program() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|e| Some(e.parent()?.join("edwin-daemon")))
        .filter(|d| d.exists())
}

/// The socket of the user's own edwind (`edwin --daemon`): $XDG_RUNTIME_DIR/edwin/edit.sock.
fn user_socket() -> Option<String> {
    std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .map(|d| format!("{d}/edwin/edit.sock"))
}

/// The command line as far as this file acts on it before V8 starts. main.ts reads it again, files and all, and
/// is the one that reports what is wrong with it.
struct Args {
    /// A window (edwin -g, edwinclient -c; the last of those and the terminal's options wins), and its size in
    /// cells (--geometry=COLSxROWS).
    window: bool,
    size: (u32, u32),
    /// --title NAME: the window's title, kept whatever the frame shows (compositor rules match it).
    title: Option<String>,
    /// edwinclient: the edwind --socket or --remote names, as an address sys::sock_open takes; -a.
    named: Option<String>,
    start: bool,
    /// edwinclient -n: where it stands on the line (its places among the arguments after the program's name), so
    /// the detached frame gets the line without it.
    no_wait: Vec<usize>,
    /// --help, --version or a usage error: main.ts answers, and no edwind, terminal or window is opened.
    answer: bool,
}

fn args(client: bool) -> Args {
    let mut o = Args {
        window: false,
        size: (100, 36),
        title: None,
        named: None,
        start: false,
        no_wait: Vec::new(),
        answer: false,
    };
    let (mut named, mut funcall, mut stdin) = (0, false, false);
    let mut naming = |o: &mut Args, k: &str, v: &str| {
        named += 1;
        if v.is_empty() || named > 1 {
            o.answer = true;
        } else if k == "--remote" {
            o.named = Some(remote_address(v));
        } else {
            o.named = Some(v.to_string());
        }
    };
    // Each argument with its place on the line; an option's value is the next one, whatever it is.
    let mut it = std::env::args().skip(1).enumerate();
    let value = |it: &mut std::iter::Enumerate<std::iter::Skip<std::env::Args>>| {
        it.next().map(|(_, v)| v).unwrap_or_default()
    };
    while let Some((i, a)) = it.next() {
        match a.as_str() {
            "--" => break,
            "-h" | "--help" | "--version" => o.answer = true,
            "-R" | "--read-only" => {}
            "-" => stdin = true,
            "-n" | "--no-wait" if client => o.no_wait.push(i),
            "-g" | "--gui" if !client => o.window = true,
            "-nw" | "--no-window" | "-t" if !client => o.window = false,
            "-c" | "--create-frame" if client => o.window = true,
            "-t" | "-nw" | "--tty" if client => o.window = false,
            "-a" | "--start-daemon" if client => o.start = true,
            "--socket" | "--remote" if client => {
                let v = value(&mut it);
                naming(&mut o, &a, &v);
            }
            "--title" => titled(&mut o, value(&mut it)),
            "-f" | "--funcall" => funcalled(&mut o, &mut funcall, &value(&mut it)),
            // The rest are forms, evaluated with no frame, so with no frame for a -f before them either.
            "-e" | "--eval" if client => {
                o.window = false;
                if it.next().is_none() || funcall {
                    o.answer = true;
                }
                break;
            }
            _ => match a.split_once('=') {
                Some((k @ ("--socket" | "--remote"), v)) if client => naming(&mut o, k, v),
                Some(("--title", v)) => titled(&mut o, v.to_string()),
                Some(("--funcall", v)) => funcalled(&mut o, &mut funcall, v),
                // As main.ts checks it.
                Some(("--geometry", g)) => match g
                    .split_once('x')
                    .and_then(|(c, r)| Some((cells(c)?, cells(r)?)))
                {
                    Some(size) => o.size = size,
                    None => o.answer = true,
                },
                _ => o.answer |= a.starts_with('-') && a.len() > 1,
            },
        }
    }
    // -n leaves a window, which nothing but -c opens, and the frame outlives this command's standard input.
    o.answer |= !o.no_wait.is_empty() && (!o.window || stdin);
    o.window &= !o.answer;
    o
}

/// --title NAME, as main.ts checks it: a name that is not empty.
fn titled(o: &mut Args, v: String) {
    if v.is_empty() {
        o.answer = true;
    } else {
        o.title = Some(v);
    }
}

/// -f NAME, as main.ts checks it: given once, and a command's name.
fn funcalled(o: &mut Args, seen: &mut bool, v: &str) {
    o.answer |= *seen || !command_name(v);
    *seen = true;
}

/// A command's name, never a form: printable ASCII of the kinds a symbol is made of, with nothing that could open
/// a form, a string or a comment.
fn command_name(v: &str) -> bool {
    !v.is_empty()
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!$%&*+-./:=?@^_~".contains(&b))
}

/// A number of --geometry: digits only (no sign), within a u32.
fn cells(n: &str) -> Option<u32> {
    n.bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| n.parse().ok())
        .flatten()
}

/// --remote HOST:SOCKET as the address sys::sock_open takes: ssh://HOST/SOCKET.
fn remote_address(r: &str) -> String {
    match r.find(":/") {
        Some(i) => format!("{}{}{}", sys::SSH_PREFIX, &r[..i], &r[i + 1..]),
        None => format!("{}{r}", sys::SSH_PREFIX),
    }
}

/// How long edwinclient waits for an edwind (through ssh, for a remote one) to answer.
const ANSWER_MS: u32 = 30000;

/// edwinclient's edwind: the one --socket or --remote names, else the first of $EDWIN_SOCKET and the user's socket
/// that answers; a remote $EDWIN_SOCKET that does not answer ends the search. With -a, when none does, the user's
/// own is started first, as `emacsclient -a ''` starts an Emacs daemon. Nothing is drawn before this answers, and
/// the connection it opens is the frame's first.
fn attach(a: &Args) -> Result<(String, u32), String> {
    let open = |p: &str| {
        sys::sock_open(p, Some(ANSWER_MS))
            .map(|id| (p.to_string(), id))
            .map_err(|e| format!("cannot attach to edwind at {p}: {e}"))
    };
    if let Some(p) = &a.named {
        return open(p);
    }
    let env = std::env::var("EDWIN_SOCKET").ok().filter(|s| !s.is_empty());
    let mut tried: Vec<String> = Vec::new();
    for p in env.into_iter().chain(user_socket()) {
        if tried.contains(&p) {
            continue;
        }
        match open(&p) {
            Ok(c) => return Ok(c),
            // A remote edwind in $EDWIN_SOCKET is the one asked for: why it did not answer (ssh's reason) is the
            // answer, rather than a frame of another edwind, or one -a starts here.
            Err(e) if p.starts_with(sys::SSH_PREFIX) => return Err(e),
            Err(_) => tried.push(p),
        }
    }
    if !a.start {
        return Err(if tried.is_empty() {
            "no edwind to attach to: neither EDWIN_SOCKET nor XDG_RUNTIME_DIR is set; give --socket PATH, or set XDG_RUNTIME_DIR and start one with `edwin --daemon`".into()
        } else {
            format!(
                "no edwind answers at {}; start one with `edwin --daemon`, or give -a",
                tried.join(" or ")
            )
        });
    }
    // -a: the user's own edwind, started as `edwin --daemon` starts it (it outlives the frame).
    let sock = user_socket().ok_or("-a needs XDG_RUNTIME_DIR for the daemon's socket")?;
    let daemon = daemon_program()
        .ok_or("-a needs edwin-daemon beside the edwin program (the Nix package installs it)")?;
    match std::process::Command::new(daemon)
        .stdin(std::process::Stdio::null())
        .status()
    {
        Ok(st) if st.success() => {}
        // It refuses when an edwind already answers there: one another edwinclient -a started meanwhile.
        Ok(st) => return open(&sock).map_err(|_| format!("edwin-daemon failed ({st})")),
        Err(e) => return Err(format!("cannot run edwin-daemon: {e}")),
    }
    let end = Instant::now() + std::time::Duration::from_secs(10);
    while Instant::now() < end {
        if let Ok(c) = open(&sock) {
            return Ok(c);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Err(format!(
        "the edwind -a started did not answer on {sock} (its log: ~/.local/state/edwin/edwind.log)"
    ))
}

#[cfg(feature = "gui")]
type Window = Option<gui::Gui>;
#[cfg(not(feature = "gui"))]
type Window = Option<()>;

/// Opens the window when one was asked for. Without one the program runs in the terminal, as asked by -nw:
/// when no display answers it says so and goes on there, if it has a terminal.
fn open_window(a: &Args) -> Result<Window, i32> {
    if !a.window {
        return Ok(None);
    }
    #[cfg(feature = "gui")]
    {
        let why = match gui::unavailable() {
            Some(why) => why,
            None => match gui::Gui::open(a.size, a.title.clone()) {
                Ok(g) => return Ok(Some(g)),
                Err(e) => e,
            },
        };
        fallback(&why)
    }
    #[cfg(not(feature = "gui"))]
    {
        fallback("this edwin was built without the window (the gui feature)")
    }
}

fn fallback(why: &str) -> Result<Window, i32> {
    // The terminal program draws on /dev/tty, whatever the standard descriptors are, so that decides.
    // SAFETY: open and close of a constant path.
    let tty = unsafe {
        let fd = libc::open(
            c"/dev/tty".as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
        );
        fd >= 0 && libc::close(fd) == 0
    };
    eprintln!(
        "{}: cannot open a window: {why}{}",
        name(),
        if tty { "; using the terminal" } else { "" }
    );
    if tty {
        Ok(None)
    } else {
        Err(1)
    }
}

/// The frame's log, the file prelude.ts's console appends to (keep the two alike): EDWIN_LOG, else edwin.log in
/// the state directory, its directory made (0700) when missing; opened to append, made 0600.
fn frame_log() -> Result<std::fs::File, String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let env = |k: &str| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let path = env("EDWIN_LOG").unwrap_or_else(|| {
        env("XDG_STATE_HOME")
            .unwrap_or_else(|| {
                env("HOME")
                    .unwrap_or_else(|| "/tmp".into())
                    .join(".local/state")
            })
            .join("edwin/edwin.log")
    });
    let made = match path.parent().filter(|d| !d.as_os_str().is_empty()) {
        Some(dir) => std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir),
        None => Ok(()),
    };
    made.and_then(|()| {
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(&path)
    })
    .map_err(|e| format!("cannot open the frame's log {}: {e}", path.display()))
}

/// edwinclient -n: what can fail is tried here, while the caller still sees what is said and the status: the window's
/// display (connected to and closed again), an edwind that answers (started first with -a), and the frame's log.
/// Then the same command line without -n runs detached, as the frame, and this returns at once. The frame has its
/// own session, so no controlling terminal and none of the terminal's signals; its standard input and output are
/// /dev/null, and its standard error is appended to its log, so what it says once detached (no GPU adapter, a -f
/// NAME that is no command) is kept; and no other descriptor of the caller's reaches it, so a caller reading this
/// command's output to its end is not held until the frame closes.
fn detach(a: &Args) -> i32 {
    use std::os::unix::process::CommandExt;
    // Every descriptor the caller left open past 0-2 is marked close-on-exec, before anything is run: the frame,
    // and with -a edwin-daemon and its edwind, or a remote edwind's ssh, get none of them. (This program opened
    // none of its own yet, and what it opens from here is close-on-exec already.)
    // SAFETY: close_range on this process's own descriptors.
    if unsafe { libc::close_range(3, u32::MAX, libc::CLOSE_RANGE_CLOEXEC as i32) } < 0 {
        eprintln!(
            "edwinclient: cannot keep its descriptors from the frame: {}",
            std::io::Error::last_os_error()
        );
        return 1;
    }
    // A display that does not answer (a stale DISPLAY or WAYLAND_DISPLAY) is said here, with status 1. This process
    // opens no window after the probe, which winit's one event loop per process would refuse.
    #[cfg(feature = "gui")]
    let no_window = gui::probe();
    #[cfg(not(feature = "gui"))]
    let no_window = Some("this edwin was built without the window (the gui feature)".to_string());
    if let Some(why) = no_window {
        eprintln!("edwinclient: cannot open a window: {why}");
        return 1;
    }
    match attach(a) {
        // The frame opens its own connection; this one (and a remote edwind's ssh) is closed first.
        Ok((_, id)) => sys::sock_close(id),
        Err(why) => {
            eprintln!("edwinclient: {why}");
            return 1;
        }
    }
    let log = match frame_log() {
        Ok(f) => f,
        Err(why) => {
            eprintln!("edwinclient: {why}");
            return 1;
        }
    };
    let Ok(exe) = std::env::current_exe() else {
        eprintln!("edwinclient: cannot find its own program");
        return 1;
    };
    let mut cmd = std::process::Command::new(exe);
    // The name it was run by, which makes it edwinclient (current_exe is edwin, where the link leads).
    cmd.arg0(std::env::args_os().next().unwrap_or_default());
    // Every argument but -n, each in its place: an option's value that reads -n stays.
    cmd.args(
        std::env::args()
            .skip(1)
            .enumerate()
            .filter(|(i, _)| !a.no_wait.contains(i))
            .map(|(_, v)| v),
    );
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(log);
    // SAFETY: setsid is async-signal-safe, as between fork and exec it must be.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    // Not waited for: once this returns the frame is init's (or a subreaper's) to reap.
    match cmd.spawn() {
        Ok(_) => 0,
        Err(e) => {
            eprintln!("edwinclient: cannot start the frame: {e}");
            1
        }
    }
}

fn run() -> i32 {
    let client = is_client();
    let args = args(client);
    if client && !args.no_wait.is_empty() && !args.answer {
        return detach(&args);
    }
    if client {
        let edwind = if args.answer {
            None
        } else {
            match attach(&args) {
                Ok(c) => Some(c),
                Err(why) => {
                    eprintln!("edwinclient: {why}");
                    return 1;
                }
            }
        };
        natives::set_client(edwind);
    }
    snapshot::init_v8(&ICU_DATA.0);
    natives::start_clock(Instant::now());
    sys::install_signals();
    // The snapshot holds edwin's own boot; edwinclient's is edwind's (Ed.bootServed), so it starts cold.
    let restore = std::env::var_os("EDWIN_NO_SNAPSHOT").is_none() && !client;
    let mut params = v8::CreateParams::default().external_references(&**natives::external_refs());
    if restore {
        params = params.snapshot_blob(&SNAPSHOT.0[..]);
    }
    let window = match open_window(&args) {
        Ok(w) => w,
        Err(code) => return code,
    };
    let isolate = &mut v8::Isolate::new(params);
    let scope = &mut v8::HandleScope::new(isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    let fresh: &[&str] = &[
        "native/prelude",
        "native/host-native",
        "native/term",
        "native/main",
    ];
    let names = if restore {
        &fresh[3..]
    } else {
        natives::install(scope, context);
        fresh
    };
    for name in names {
        if !natives::run_source(scope, name) {
            sys::tty_close();
            return 70;
        }
        scope.perform_microtask_checkpoint();
        if let Some(code) = natives::exit_code() {
            sys::tty_close();
            return code;
        }
    }
    #[cfg(feature = "gui")]
    if let Some(gui) = window {
        return gui_loop(scope, context, gui);
    }
    #[cfg(not(feature = "gui"))]
    let _ = window;
    let code = event_loop(scope, context);
    sys::tty_close();
    code
}

fn global_fn<'s>(
    scope: &mut v8::HandleScope<'s>,
    obj: v8::Local<v8::Object>,
    name: &str,
) -> v8::Local<'s, v8::Function> {
    let k = v8::String::new(scope, name).unwrap();
    v8::Local::<v8::Function>::try_from(obj.get(scope, k.into()).unwrap())
        .unwrap_or_else(|_| panic!("__native.{name} is not a function"))
}

fn event_loop(scope: &mut v8::HandleScope, context: v8::Local<v8::Context>) -> i32 {
    let g = context.global(scope);
    let k = v8::String::new(scope, "__native").unwrap();
    let nat = g.get(scope, k.into()).unwrap().to_object(scope).unwrap();
    let (tick, next, input) = (
        global_fn(scope, nat, "tick"),
        global_fn(scope, nat, "next"),
        global_fn(scope, nat, "input"),
    );
    let (signal, sock) = (
        global_fn(scope, nat, "signal"),
        global_fn(scope, nat, "sock"),
    );
    let recv: v8::Local<v8::Value> = nat.into();
    let mut next_ms: f64 = 0.0;
    loop {
        sys::flush_out();
        if let Some(code) = natives::exit_code() {
            return code;
        }
        let timeout = if next_ms < 0.0 {
            -1
        } else {
            next_ms.ceil().min(i32::MAX as f64) as i32
        };
        let ready = sys::wait(timeout);
        for sig in ready.signals {
            let s = v8::String::new(scope, sig).unwrap();
            let tc = &mut v8::TryCatch::new(scope);
            signal.call(tc, recv, &[s.into()]);
            tc.perform_microtask_checkpoint();
        }
        if let Some(text) = ready.input {
            let s = v8::String::new(scope, &text).unwrap();
            let tc = &mut v8::TryCatch::new(scope);
            input.call(tc, recv, &[s.into()]);
            tc.perform_microtask_checkpoint();
        }
        if ready.tty_gone {
            // The terminal hung up without a SIGHUP reaching us (a closed pty): the same path.
            let s = v8::String::new(scope, "HUP").unwrap();
            signal.call(scope, recv, &[s.into()]);
        }
        for (id, line) in ready.socket_lines {
            let a0 = v8::Integer::new(scope, id as i32).into();
            let a1 = match line {
                Some(l) => v8::String::new(scope, &l).unwrap().into(),
                None => v8::null(scope).into(),
            };
            let tc = &mut v8::TryCatch::new(scope);
            sock.call(tc, recv, &[a0, a1]);
            tc.perform_microtask_checkpoint();
        }
        if natives::exit_code().is_some() {
            continue;
        }
        let tc = &mut v8::TryCatch::new(scope);
        tick.call(tc, recv, &[]);
        tc.perform_microtask_checkpoint();
        next_ms = next
            .call(tc, recv, &[])
            .and_then(|v| v.number_value(tc))
            .unwrap_or(-1.0);
        if natives::idle_without_work() && next_ms < 0.0 {
            // No terminal, no socket, no timer: nothing can happen any more.
            return natives::exit_code().unwrap_or(0);
        }
    }
}

/// The window's loop: the terminal loop's steps, with the window's events pumped where the terminal is polled.
#[cfg(feature = "gui")]
fn gui_loop(
    scope: &mut v8::HandleScope,
    context: v8::Local<v8::Context>,
    mut gui: gui::Gui,
) -> i32 {
    let g = context.global(scope);
    let k = v8::String::new(scope, "__native").unwrap();
    let nat = g.get(scope, k.into()).unwrap().to_object(scope).unwrap();
    let (tick, next, signal, sock) = (
        global_fn(scope, nat, "tick"),
        global_fn(scope, nat, "next"),
        global_fn(scope, nat, "signal"),
        global_fn(scope, nat, "sock"),
    );
    let k = v8::String::new(scope, "gui").unwrap();
    let on_event = nat
        .get(scope, k.into())
        .and_then(|v| v8::Local::<v8::Function>::try_from(v).ok());
    let recv: v8::Local<v8::Value> = nat.into();
    let mut next_ms: f64 = 0.0;
    loop {
        gui.present();
        if let Some(code) = natives::exit_code() {
            return code;
        }
        if gui.closed() {
            // The system took the window away: as the terminal hanging up.
            let s = v8::String::new(scope, "HUP").unwrap();
            signal.call(scope, recv, &[s.into()]);
            return natives::exit_code().unwrap_or(1);
        }
        let timeout =
            (next_ms >= 0.0).then(|| std::time::Duration::from_micros((next_ms * 1000.0) as u64));
        gui.pump(timeout, sys::poll_fds());
        let ready = sys::wait(0);
        for sig in ready.signals {
            let s = v8::String::new(scope, sig).unwrap();
            let tc = &mut v8::TryCatch::new(scope);
            signal.call(tc, recv, &[s.into()]);
            tc.perform_microtask_checkpoint();
        }
        for (id, line) in ready.socket_lines {
            let a0 = v8::Integer::new(scope, id as i32).into();
            let a1 = match line {
                Some(l) => v8::String::new(scope, &l).unwrap().into(),
                None => v8::null(scope).into(),
            };
            let tc = &mut v8::TryCatch::new(scope);
            sock.call(tc, recv, &[a0, a1]);
            tc.perform_microtask_checkpoint();
        }
        if let Some(f) = on_event {
            for ev in gui.take_events() {
                let s = v8::String::new(scope, &ev).unwrap();
                let tc = &mut v8::TryCatch::new(scope);
                f.call(tc, recv, &[s.into()]);
                tc.perform_microtask_checkpoint();
            }
        }
        if natives::exit_code().is_some() {
            continue;
        }
        let tc = &mut v8::TryCatch::new(scope);
        tick.call(tc, recv, &[]);
        tc.perform_microtask_checkpoint();
        next_ms = next
            .call(tc, recv, &[])
            .and_then(|v| v.number_value(tc))
            .unwrap_or(-1.0);
    }
}
