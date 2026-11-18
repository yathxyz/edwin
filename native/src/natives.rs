//! __n: what the JavaScript host gets from Rust. Files throw JS errors with the system's message; reading a
//! missing file gives null, as host.files.read promises.

use crate::{bridge, open, proc, sources, syntax, sys};
use std::cell::{Cell, OnceCell};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::Instant;

thread_local! {
    static EXIT: Cell<Option<i32>> = const { Cell::new(None) };
    static CLOCK: OnceCell<Instant> = const { OnceCell::new() };
}

pub fn start_clock(t: Instant) {
    CLOCK.with(|c| {
        let _ = c.set(t);
    });
}
pub fn exit_code() -> Option<i32> {
    EXIT.with(|e| e.get())
}
/// Nothing left that could wake the loop: no terminal, no socket and no child (timers are JS's to report).
pub fn idle_without_work() -> bool {
    !sys::tty_is_open() && sys::sock_count() == 0 && proc::count() == 0
}

fn throw(scope: &mut v8::HandleScope, msg: &str) {
    let m = v8::String::new(scope, msg).unwrap();
    let e = v8::Exception::error(scope, m);
    scope.throw_exception(e);
}
fn arg_str(scope: &mut v8::HandleScope, args: &v8::FunctionCallbackArguments, i: i32) -> String {
    args.get(i).to_rust_string_lossy(scope)
}
fn ret_str(scope: &mut v8::HandleScope, rv: &mut v8::ReturnValue, s: &str) {
    match v8::String::new(scope, s) {
        Some(v) => rv.set(v.into()),
        None => throw(scope, "string too long for V8"),
    }
}
/// The system's message without its error number ("Permission denied"). File errors say no path: the caller
/// names the file (the core's "Cannot write NAME: ...").
fn sys_msg(e: &std::io::Error) -> String {
    let m = e.to_string();
    m.split(" (os error").next().unwrap_or(&m).to_string()
}
fn io_msg(path: &str, e: &std::io::Error) -> String {
    format!("{path}: {}", sys_msg(e))
}

/// Compile and run one of the embedded sources; an exception is printed and reported as false.
pub fn run_source(scope: &mut v8::HandleScope, name: &str) -> bool {
    let Some(src) = sources::js(name) else {
        eprintln!("edwin: no embedded source {name}");
        return false;
    };
    let tc = &mut v8::TryCatch::new(scope);
    let code = v8::String::new(tc, src).unwrap();
    let file = if name.starts_with("native/") {
        format!("edwin/{}.ts", name.replacen("native/", "native/js/", 1))
    } else {
        format!("edwin/src/{name}.ts")
    };
    let origin_name = v8::String::new(tc, &file).unwrap();
    let origin = v8::ScriptOrigin::new(
        tc,
        origin_name.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        false,
        None,
    );
    if v8::Script::compile(tc, code, Some(&origin))
        .and_then(|s| s.run(tc))
        .is_some()
    {
        return true;
    }
    let msg = match tc.exception() {
        Some(e) => {
            let stack = tc.stack_trace().map(|s| s.to_rust_string_lossy(tc));
            stack.unwrap_or_else(|| e.to_rust_string_lossy(tc))
        }
        None => "terminated".into(),
    };
    sys::tty_close();
    eprintln!("edwin: {file}: {msg}");
    false
}

fn load(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let name = arg_str(scope, &args, 0);
    if !run_source(scope, &name) {
        EXIT.with(|e| e.set(Some(70)));
        throw(scope, &format!("cannot load {name}"));
    }
}

fn print(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let s = arg_str(scope, &args, 0);
    let _ = std::io::stdout().write_all(s.as_bytes());
    let _ = std::io::stdout().flush();
}
fn eprint(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let s = arg_str(scope, &args, 0);
    let _ = std::io::stderr().write_all(s.as_bytes());
}
fn env(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let k = arg_str(scope, &args, 0);
    if let Ok(v) = std::env::var(&k) {
        ret_str(scope, &mut rv, &v);
    }
}
fn cwd(scope: &mut v8::HandleScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let d = std::env::var("PWD")
        .ok()
        .filter(|p| Path::new(p).is_absolute() && same_dir(p))
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        });
    ret_str(scope, &mut rv, &d.unwrap_or_else(|| "/".into()));
}
/// $PWD keeps the user's spelling of the directory (through symlinks), when it still names where we are.
fn same_dir(p: &str) -> bool {
    match (std::fs::metadata(p), std::fs::metadata(".")) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}
fn now(scope: &mut v8::HandleScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let ms = CLOCK.with(|c| {
        c.get()
            .map(|t| t.elapsed().as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    });
    rv.set(v8::Number::new(scope, ms).into());
}

fn read_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    if args.length() > 1 && !args.get(1).is_undefined() {
        let max = args.get(1).number_value(scope).unwrap_or(0.0).max(0.0) as u64;
        return match read_regular(&p, max) {
            Ok(None) => rv.set(v8::null(scope).into()),
            Ok(Some(bytes)) => match String::from_utf8(bytes) {
                Ok(s) => ret_str(scope, &mut rv, &s),
                Err(_) => throw(scope, "not UTF-8 text"),
            },
            Err(msg) => throw(scope, &msg),
        };
    }
    match std::fs::metadata(&p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            rv.set(v8::null(scope).into());
            return;
        }
        Ok(m) if m.is_dir() => return throw(scope, "is a directory"),
        _ => {}
    }
    match std::fs::read(&p) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => ret_str(scope, &mut rv, &s),
            Err(_) => throw(scope, "not UTF-8 text"),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => rv.set(v8::null(scope).into()),
        Err(e) => throw(scope, &sys_msg(&e)),
    }
}

/// readFile(PATH, MAX): the bytes of PATH (its links followed) when it is a regular file of at most MAX bytes;
/// None when nothing is there. Anything else (a directory, a device, a FIFO, a socket, a larger file) is
/// refused before a byte is read: the name is checked before the open (so no device is even opened), the file
/// opened without blocking and checked again on its descriptor (should the name have changed in between), and
/// read no further than MAX and one byte, should it have grown.
fn read_regular(p: &str, max: u64) -> Result<Option<Vec<u8>>, String> {
    match std::fs::metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(sys_msg(&e)),
        Ok(m) if !m.is_file() => return Err("not a regular file".into()),
        Ok(_) => {}
    }
    let mut f = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(p)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(sys_msg(&e)),
    };
    let m = f.metadata().map_err(|e| sys_msg(&e))?;
    if !m.is_file() {
        return Err("not a regular file".into());
    }
    let too_large = || format!("larger than {max} bytes");
    if m.len() > max {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(m.len() as usize);
    (&mut f)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| sys_msg(&e))?;
    if bytes.len() as u64 > max {
        return Err(too_large());
    }
    Ok(Some(bytes))
}

/// Write TEXT to PATH. An ordinary file is replaced atomically: a temporary file beside it with the old
/// file's mode, written and synced, then renamed over it. A symlink, a file with other hard links, or a file
/// in a directory we may not create files in is written in place, so the link and the inode stay as they are.
fn write_atomic(p: &str, text: &[u8]) -> std::io::Result<()> {
    let path = Path::new(p);
    let meta = std::fs::symlink_metadata(path).ok();
    let in_place = meta
        .as_ref()
        .map(|m| m.file_type().is_symlink() || m.nlink() > 1)
        .unwrap_or(false);
    let write_in_place = || -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)?;
        f.write_all(text)?;
        f.sync_all()
    };
    if in_place {
        return write_in_place();
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let base = path
        .file_name()
        .map(|b| b.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{base}.edwin-{}~", std::process::id()));
    let mode = meta.as_ref().map(|m| m.permissions().mode() & 0o7777);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true)
        .create_new(true)
        .mode(mode.unwrap_or(0o666));
    let mut f = match opts.open(&tmp) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && meta.is_some() => {
            return write_in_place()
        }
        Err(e) => return Err(e),
    };
    let done = (|| {
        f.write_all(text)?;
        if let Some(m) = mode {
            f.set_permissions(std::fs::Permissions::from_mode(m))?;
        }
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return done;
    }
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}
fn write_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    let t = arg_str(scope, &args, 1);
    if let Err(e) = write_atomic(&p, t.as_bytes()) {
        throw(scope, &sys_msg(&e));
    }
}
fn append_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    let t = arg_str(scope, &args, 1);
    let r = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(&p)
        .and_then(|mut f| f.write_all(t.as_bytes()));
    if let Err(e) = r {
        throw(scope, &io_msg(&p, &e));
    }
}
fn set(scope: &mut v8::HandleScope, o: v8::Local<v8::Object>, k: &str, v: v8::Local<v8::Value>) {
    let key = v8::String::new(scope, k).unwrap();
    o.set(scope, key.into(), v);
}
fn stat(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let p = arg_str(scope, &args, 0);
    match std::fs::metadata(&p) {
        Ok(m) => {
            let o = v8::Object::new(scope);
            let dir = v8::Boolean::new(scope, m.is_dir()).into();
            set(scope, o, "dir", dir);
            let size = v8::Number::new(scope, m.len() as f64).into();
            set(scope, o, "size", size);
            let mtime = v8::Number::new(
                scope,
                m.mtime() as f64 * 1000.0 + (m.mtime_nsec() / 1_000_000) as f64,
            )
            .into();
            set(scope, o, "mtime", mtime);
            let mode = v8::Integer::new(scope, (m.mode() & 0o7777) as i32).into();
            set(scope, o, "mode", mode);
            // auto-revert tells a file's versions apart by these: the inode (a file replaced by a rename has
            // another) and the modification time's nanoseconds, which mtime's milliseconds round away.
            let ino = v8::Number::new(scope, m.ino() as f64).into();
            set(scope, o, "ino", ino);
            let nsec = v8::Integer::new(scope, m.mtime_nsec() as i32).into();
            set(scope, o, "nsec", nsec);
            rv.set(o.into());
        }
        Err(_) => rv.set(v8::null(scope).into()),
    }
}
/// The file's true name: the absolute path with every symbolic link resolved. For a file that does not exist
/// yet, its directory's true name and its own name; null when the directory does not exist either.
fn realpath(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let p = std::path::PathBuf::from(arg_str(scope, &args, 0));
    let t = std::fs::canonicalize(&p).ok().or_else(|| {
        let (dir, name) = (p.parent()?, p.file_name()?);
        Some(std::fs::canonicalize(dir).ok()?.join(name))
    });
    match t.and_then(|t| t.to_str().map(|s| s.to_owned())) {
        Some(t) => {
            let v = v8::String::new(scope, &t).unwrap();
            rv.set(v.into());
        }
        None => rv.set(v8::null(scope).into()),
    }
}
fn read_dir(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    match std::fs::read_dir(&p) {
        Ok(rd) => {
            let arr = v8::Array::new(scope, 0);
            for (i, ent) in rd.flatten().enumerate() {
                let name = ent.file_name().to_string_lossy().into_owned();
                let dir = ent
                    .file_type()
                    .map(|t| t.is_dir() || (t.is_symlink() && ent.path().is_dir()))
                    .unwrap_or(false);
                let pair = v8::Array::new(scope, 2);
                let n = v8::String::new(scope, &name).unwrap().into();
                pair.set_index(scope, 0, n);
                let d = v8::Boolean::new(scope, dir).into();
                pair.set_index(scope, 1, d);
                arr.set_index(scope, i as u32, pair.into());
            }
            rv.set(arr.into());
        }
        Err(e) => throw(scope, &io_msg(&p, &e)),
    }
}
fn remove(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let p = arg_str(scope, &args, 0);
    if let Err(e) = std::fs::remove_file(&p) {
        if e.kind() != std::io::ErrorKind::NotFound {
            throw(scope, &io_msg(&p, &e));
        }
    }
}
/// Make a directory and the parents it lacks: private (0700) unless a second argument gives the mode, which
/// the umask then narrows.
fn mkdirs(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let p = arg_str(scope, &args, 0);
    let mode = if args.length() > 1 {
        args.get(1).uint32_value(scope).unwrap_or(0o700)
    } else {
        0o700
    };
    if let Err(e) = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(mode)
        .create(&p)
    {
        throw(scope, &io_msg(&p, &e));
    }
}
/// One name as dired lists it, a final symbolic link not followed: its kind, size, time and permission bits,
/// and for a link its target as written and whether it leads to a directory. null when nothing is there.
fn lstat(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    let Ok(m) = std::fs::symlink_metadata(&p) else {
        rv.set(v8::null(scope).into());
        return;
    };
    let t = m.file_type();
    let kind = if t.is_dir() {
        "dir"
    } else if t.is_file() {
        "file"
    } else if t.is_symlink() {
        "link"
    } else {
        "other"
    };
    let o = v8::Object::new(scope);
    let v = v8::String::new(scope, kind).unwrap().into();
    set(scope, o, "kind", v);
    let v = v8::Number::new(scope, m.len() as f64).into();
    set(scope, o, "size", v);
    let v = v8::Number::new(
        scope,
        m.mtime() as f64 * 1000.0 + (m.mtime_nsec() / 1_000_000) as f64,
    )
    .into();
    set(scope, o, "mtime", v);
    let v = v8::Integer::new(scope, (m.mode() & 0o7777) as i32).into();
    set(scope, o, "mode", v);
    if t.is_symlink() {
        if let Ok(target) = std::fs::read_link(&p) {
            let v = v8::String::new(scope, &target.to_string_lossy())
                .unwrap()
                .into();
            set(scope, o, "target", v);
        }
        if std::fs::metadata(&p).map(|m| m.is_dir()).unwrap_or(false) {
            let v = v8::Boolean::new(scope, true).into();
            set(scope, o, "dir", v);
        }
    }
    rv.set(o.into());
}
/// Rename or move within a file system. A destination that exists is replaced, as rename(2) does: the
/// caller looks first.
fn rename(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let (src, dst) = (arg_str(scope, &args, 0), arg_str(scope, &args, 1));
    if let Err(e) = std::fs::rename(&src, &dst) {
        throw(scope, &io_msg(&src, &e));
    }
}
/// Copy a file, a symbolic link (as a link) or a directory with everything in it. Every name is made new,
/// so nothing is overwritten; a socket, a device or a pipe is refused.
fn copy_into(src: &Path, dst: &Path) -> std::io::Result<()> {
    let m = std::fs::symlink_metadata(src)?;
    let t = m.file_type();
    if t.is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(src)?, dst)
    } else if t.is_dir() {
        // Writable while it is filled; the source's permissions once it is.
        std::fs::DirBuilder::new().mode(0o700).create(dst)?;
        for ent in std::fs::read_dir(src)? {
            let ent = ent?;
            copy_into(&ent.path(), &dst.join(ent.file_name()))?;
        }
        std::fs::set_permissions(dst, std::fs::Permissions::from_mode(m.mode() & 0o777))
    } else if t.is_file() {
        let mut from = std::fs::File::open(src)?;
        let mut to = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(m.mode() & 0o777)
            .open(dst)?;
        std::io::copy(&mut from, &mut to).map(|_| ())
    } else {
        Err(std::io::Error::other("Not a file, a link or a directory"))
    }
}
fn copy_tree(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let (src, dst) = (arg_str(scope, &args, 0), arg_str(scope, &args, 1));
    if let Err(e) = copy_into(Path::new(&src), Path::new(&dst)) {
        throw(scope, &io_msg(&src, &e));
    }
}
/// Remove a directory: an empty one, or with a true second argument everything in it (links are removed,
/// never followed).
fn remove_dir(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    let r = if args.get(1).boolean_value(scope) {
        std::fs::remove_dir_all(&p)
    } else {
        std::fs::remove_dir(&p)
    };
    if let Err(e) = r {
        throw(scope, &io_msg(&p, &e));
    }
}
fn read_stdin(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let mut b = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut b);
    ret_str(scope, &mut rv, &String::from_utf8_lossy(&b));
}

fn tty_open(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Boolean::new(scope, sys::tty_open()).into());
}
fn tty_close(
    _scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    sys::tty_close();
}
fn tty_write(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let s = arg_str(scope, &args, 0);
    sys::tty_write(&s);
}
fn tty_flush(
    _scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    sys::flush_out();
}
fn tty_size(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let (c, r) = sys::tty_size();
    let arr = v8::Array::new(scope, 2);
    let a = v8::Integer::new(scope, c as i32).into();
    arr.set_index(scope, 0, a);
    let b = v8::Integer::new(scope, r as i32).into();
    arr.set_index(scope, 1, b);
    rv.set(arr.into());
}
fn suspend(
    _scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    sys::suspend();
}
fn exit(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let code = args.get(0).int32_value(scope).unwrap_or(0);
    sys::flush_out();
    EXIT.with(|e| e.set(Some(code & 255)));
}
fn sock_open(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    match sys::sock_open(&p, None) {
        Ok(id) => rv.set(v8::Integer::new(scope, id as i32).into()),
        Err(e) => throw(scope, &format!("{p}: {e}")),
    }
}
fn sock_send(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let line = arg_str(scope, &args, 1);
    rv.set(v8::Boolean::new(scope, sys::sock_send(id, &line)).into());
}
/// Why remote socket ID closed (ssh's last line), or null.
fn sock_error(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    match sys::sock_error(id) {
        Some(e) => rv.set(v8::String::new(scope, &e).unwrap().into()),
        None => rv.set_null(),
    }
}
fn sock_close(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    sys::sock_close(id);
}

/* ---------- child processes (proc.rs): argv only, never a shell ---------- */
/// procSpawn(argv, {cwd, env, timeout, maxBytes, lossy, merge}): the child's id; throws when it cannot run.
fn proc_spawn(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    match proc_spec(scope, &args).and_then(proc::spawn) {
        Ok(id) => rv.set(v8::Integer::new_from_unsigned(scope, id).into()),
        Err(e) => throw(scope, &e),
    }
}
/// Option K of O, unless it is undefined or null.
fn opt<'s>(
    scope: &mut v8::HandleScope<'s>,
    o: v8::Local<v8::Object>,
    k: &str,
) -> Option<v8::Local<'s, v8::Value>> {
    let key = v8::String::new(scope, k).unwrap();
    o.get(scope, key.into())
        .filter(|v| !v.is_null_or_undefined())
}
/// A count of milliseconds or bytes: a number, finite and not negative.
fn amount(scope: &mut v8::HandleScope, v: v8::Local<v8::Value>, k: &str) -> Result<f64, String> {
    v.number_value(scope)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or(format!(
            "procSpawn: {k} is not a number of milliseconds or bytes"
        ))
}
fn proc_spec<'s>(
    scope: &mut v8::HandleScope<'s>,
    args: &v8::FunctionCallbackArguments,
) -> Result<proc::Spec, String> {
    let argv = v8::Local::<v8::Array>::try_from(args.get(0))
        .map_err(|_| "procSpawn: argv is not an array")?;
    let mut spec = proc::Spec::default();
    for i in 0..argv.length() {
        let v = argv
            .get_index(scope, i)
            .filter(|v| v.is_string())
            .ok_or("procSpawn: argv holds strings only")?;
        spec.argv.push(v.to_rust_string_lossy(scope));
    }
    let Ok(opts) = v8::Local::<v8::Object>::try_from(args.get(1)) else {
        return Ok(spec);
    };
    let get = |scope: &mut v8::HandleScope<'s>, k: &str| opt(scope, opts, k);
    if let Some(v) = get(scope, "cwd") {
        spec.cwd = Some(v.to_rust_string_lossy(scope));
    }
    if let Some(v) = get(scope, "env") {
        let env =
            v8::Local::<v8::Object>::try_from(v).map_err(|_| "procSpawn: env is not an object")?;
        let names = env
            .get_own_property_names(scope, Default::default())
            .ok_or("procSpawn: env has no names")?;
        for i in 0..names.length() {
            let k = names.get_index(scope, i).unwrap();
            let v = env.get(scope, k).unwrap();
            let k = k.to_rust_string_lossy(scope);
            spec.env.push((
                k,
                (!v.is_null_or_undefined()).then(|| v.to_rust_string_lossy(scope)),
            ));
        }
    }
    if let Some(v) = get(scope, "timeout") {
        // Too long for a Duration is no timeout at all (the loop would never get there).
        spec.timeout =
            std::time::Duration::try_from_secs_f64(amount(scope, v, "timeout")? / 1000.0).ok();
    }
    if let Some(v) = get(scope, "maxBytes") {
        spec.max_bytes = Some(amount(scope, v, "maxBytes")? as usize);
    }
    spec.lossy = get(scope, "lossy").is_some_and(|v| v.boolean_value(scope));
    spec.merge = get(scope, "merge").is_some_and(|v| v.boolean_value(scope));
    Ok(spec)
}
/// procWrite(id, text): queued for the child's standard input; false once that is closed.
fn proc_write(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let text = arg_str(scope, &args, 1);
    match proc::write(id, text.as_bytes()) {
        Ok(b) => rv.set(v8::Boolean::new(scope, b).into()),
        Err(e) => throw(scope, &e),
    }
}
fn proc_close_stdin(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    proc::close_stdin(id);
}
/// procKill(id, signal = 'TERM'): to the child and what it started; false when it is not running.
fn proc_kill(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let name = if args.get(1).is_undefined() {
        "TERM".to_string()
    } else {
        arg_str(scope, &args, 1)
    };
    match proc::signal_number(&name) {
        Some(sig) => rv.set(v8::Boolean::new(scope, proc::kill(id, sig)).into()),
        None => throw(scope, &format!("procKill: no signal {name}")),
    }
}
/// procList(): [{id, pid, argv}] of the children not yet reported ended.
fn proc_list(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let arr = v8::Array::new(scope, 0);
    for (i, (id, pid, argv)) in proc::list().into_iter().enumerate() {
        let o = v8::Object::new(scope);
        let v = v8::Integer::new_from_unsigned(scope, id).into();
        set(scope, o, "id", v);
        let v = v8::Integer::new_from_unsigned(scope, pid).into();
        set(scope, o, "pid", v);
        let a = v8::Array::new(scope, argv.len() as i32);
        for (j, s) in argv.iter().enumerate() {
            let v = v8::String::new(scope, s).unwrap().into();
            a.set_index(scope, j as u32, v);
        }
        set(scope, o, "argv", a.into());
        arr.set_index(scope, i as u32, o.into());
    }
    rv.set(arr.into());
}
/* ---------- the desktop's opener (open.rs): xdg-open TARGET, after its checks ---------- */
/// openExternal(target, confirmed = false): null once the opener has started, else why not.
fn open_external(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let target = args.get(0);
    if !target.is_string() {
        return ret_str(scope, &mut rv, "Nothing to open");
    }
    let target = target.to_rust_string_lossy(scope);
    match open::open(&target, args.get(1).boolean_value(scope)) {
        Ok(()) => rv.set(v8::null(scope).into()),
        Err(e) => ret_str(scope, &mut rv, &e),
    }
}

/* ---------- tree-sitter (syntax.rs): the bundle's grammars by name, trees by number ---------- */
fn str_array<'s>(scope: &mut v8::HandleScope<'s>, items: &[String]) -> v8::Local<'s, v8::Array> {
    let a = v8::Array::new(scope, items.len() as i32);
    for (i, s) in items.iter().enumerate() {
        let v = v8::String::new(scope, s).unwrap().into();
        a.set_index(scope, i as u32, v);
    }
    a
}
/// synLoad(name): the query kinds of NAME's grammar, which is loaded on first use; throws when it cannot be.
fn syn_load(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let name = arg_str(scope, &args, 0);
    match syntax::grammar(&name) {
        Ok(g) => rv.set(str_array(scope, g.kinds()).into()),
        Err(e) => throw(scope, &e),
    }
}
/// synParse(name, text): TEXT parsed with NAME's grammar; the tree's number, for synQuery and synFree.
fn syn_parse(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let name = arg_str(scope, &args, 0);
    let Ok(s) = v8::Local::<v8::String>::try_from(args.get(1)) else {
        return throw(scope, "synParse: the text is not a string");
    };
    let mut text = vec![0u16; s.length()];
    s.write(scope, &mut text, 0, v8::WriteOptions::NO_NULL_TERMINATION);
    match syntax::parse(&name, text) {
        Ok(id) => rv.set(v8::Integer::new_from_unsigned(scope, id).into()),
        Err(e) => throw(scope, &e),
    }
}
/// A string index: a number, finite and not negative (undefined: none); WHO is the native, for the error.
fn index(
    scope: &mut v8::HandleScope,
    v: v8::Local<v8::Value>,
    who: &str,
) -> Result<Option<usize>, String> {
    if v.is_undefined() {
        return Ok(None);
    }
    v.number_value(scope)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| Some(n as usize))
        .ok_or_else(|| format!("{who}: start and end are string indices"))
}
/// synQuery(tree, kind, start = 0, end = its length, matches = false): the captures of the grammar's KIND query
/// that overlap [start, end), in the order of the text, as {names, captures}: captures holds four numbers per
/// capture (its index in names, its start and end as indices of the parsed string, the pattern that matched).
/// With MATCHES true there is also matches, a number per capture that the captures of one match share (imenu
/// pairs a tags query's @name with its @definition by it; highlighting does not ask for it).
fn syn_query(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let kind = arg_str(scope, &args, 1);
    let found = index(scope, args.get(2), "synQuery").and_then(|start| {
        let end = index(scope, args.get(3), "synQuery")?;
        syntax::query(id, &kind, start.unwrap_or(0), end)
    });
    let (names, caps) = match found {
        Ok(r) => r,
        Err(e) => return throw(scope, &e),
    };
    let o = v8::Object::new(scope);
    let v = str_array(scope, &names).into();
    set(scope, o, "names", v);
    let flat = v8::Array::new(scope, (caps.len() * 4) as i32);
    for (i, c) in caps.iter().enumerate() {
        for (j, n) in [
            c.capture as f64,
            c.start as f64,
            c.end as f64,
            c.pattern as f64,
        ]
        .into_iter()
        .enumerate()
        {
            let v = v8::Number::new(scope, n).into();
            flat.set_index(scope, (i * 4 + j) as u32, v);
        }
    }
    set(scope, o, "captures", flat.into());
    if args.get(4).is_true() {
        let ids = v8::Array::new(scope, caps.len() as i32);
        for (i, c) in caps.iter().enumerate() {
            let v = v8::Integer::new_from_unsigned(scope, c.id).into();
            ids.set_index(scope, i as u32, v);
        }
        set(scope, o, "matches", ids.into());
    }
    rv.set(o.into());
}
/// synNodes(tree, start, end = start): the extents of the tree's named nodes that hold [start, end), innermost
/// first, out to the root, each once (syntax::nodes), as two numbers each, indices of the parsed string: the
/// steps expreg grows a selection by.
fn syn_nodes(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let found = index(scope, args.get(1), "synNodes").and_then(|start| {
        let start = start.unwrap_or(0);
        let end = index(scope, args.get(2), "synNodes")?.unwrap_or(start);
        syntax::nodes(id, start, end.max(start))
    });
    let spans = match found {
        Ok(r) => r,
        Err(e) => return throw(scope, &e),
    };
    let flat = v8::Array::new(scope, (spans.len() * 2) as i32);
    for (i, (s, e)) in spans.into_iter().enumerate() {
        for (j, n) in [s, e].into_iter().enumerate() {
            let v = v8::Number::new(scope, n as f64).into();
            flat.set_index(scope, (i * 2 + j) as u32, v);
        }
    }
    rv.set(flat.into());
}
/// synEdit(tree, pos, del, ins): the tree's text changed, DEL code units at POS replaced by INS, and the tree parsed
/// again from itself (syntax::edit); throws when the edit is not in its text or the reparse fails, which frees it.
fn syn_edit(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let mut count = |i: i32| {
        args.get(i)
            .number_value(scope)
            .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
            .map(|n| n as usize)
    };
    let (Some(pos), Some(del)) = (count(1), count(2)) else {
        return throw(
            scope,
            "synEdit: the position and the length deleted are string indices",
        );
    };
    let Ok(s) = v8::Local::<v8::String>::try_from(args.get(3)) else {
        return throw(scope, "synEdit: the text inserted is not a string");
    };
    let mut ins = vec![0u16; s.length()];
    s.write(scope, &mut ins, 0, v8::WriteOptions::NO_NULL_TERMINATION);
    if let Err(e) = syntax::edit(id, pos, del, &ins) {
        throw(scope, &e);
    }
}
/// synFree(tree): the tree forgotten; false when there was none.
fn syn_free(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    rv.set(v8::Boolean::new(scope, syntax::free(id)).into());
}

/// A child's event as the arguments of __native.proc: (id, 'out' | 'err', text) or (id, 'exit', {code, signal,
/// timedOut, truncated, error?}).
pub fn proc_event<'s>(
    scope: &mut v8::HandleScope<'s>,
    ev: proc::Event,
) -> [v8::Local<'s, v8::Value>; 3] {
    let (id, kind, data): (u32, &str, v8::Local<v8::Value>) = match ev {
        proc::Event::Out(id, t) => (id, "out", v8::String::new(scope, &t).unwrap().into()),
        proc::Event::Err(id, t) => (id, "err", v8::String::new(scope, &t).unwrap().into()),
        proc::Event::Exit(id, x) => {
            let o = v8::Object::new(scope);
            let v = match x.code {
                Some(c) => v8::Integer::new(scope, c).into(),
                None => v8::null(scope).into(),
            };
            set(scope, o, "code", v);
            let v = match &x.signal {
                Some(s) => v8::String::new(scope, s).unwrap().into(),
                None => v8::null(scope).into(),
            };
            set(scope, o, "signal", v);
            let v = v8::Boolean::new(scope, x.timed_out).into();
            set(scope, o, "timedOut", v);
            let v = v8::Boolean::new(scope, x.truncated).into();
            set(scope, o, "truncated", v);
            if let Some(e) = &x.error {
                let v = v8::String::new(scope, e).unwrap().into();
                set(scope, o, "error", v);
            }
            (id, "exit", o.into())
        }
    };
    let id = v8::Integer::new_from_unsigned(scope, id).into();
    let kind = v8::String::new(scope, kind).unwrap().into();
    [id, kind, data]
}

/* ---------- edwinclient: main.rs found its edwind before V8 started ---------- */
thread_local! {
    static CLIENT: Cell<bool> = const { Cell::new(false) };
    static EDWIND: std::cell::RefCell<Option<(String, u32)>> = const { std::cell::RefCell::new(None) };
}
/// The program runs as edwinclient; EDWIND is the edwind it attached to and the connection it opened (none
/// when main.ts is to answer first: --help, --version, a usage error).
pub fn set_client(edwind: Option<(String, u32)>) {
    CLIENT.with(|c| c.set(true));
    EDWIND.with(|e| *e.borrow_mut() = edwind);
}
/// Whether the program runs as edwinclient.
fn client(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Boolean::new(scope, CLIENT.with(|c| c.get())).into());
}
/// [address, connection] of edwinclient's edwind, or null.
fn edwind(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    match EDWIND.with(|e| e.borrow().clone()) {
        Some((addr, id)) => {
            let a: v8::Local<v8::Value> = v8::String::new(scope, &addr).unwrap().into();
            let i: v8::Local<v8::Value> = v8::Integer::new_from_unsigned(scope, id).into();
            rv.set(v8::Array::new_with_elements(scope, &[a, i]).into());
        }
        None => rv.set_null(),
    }
}

/* ---------- the window (DT2): through the bridge, so this file needs no graphics library ---------- */
/// {cols, rows, theme} of the open window, or null when the program runs in a terminal.
fn gui_size(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let size = bridge::with(|b| b.open.then(|| (b.cols, b.rows, b.theme.clone())));
    match size {
        Some((cols, rows, theme)) => {
            let o = v8::Object::new(scope);
            let c = v8::Integer::new_from_unsigned(scope, cols).into();
            set(scope, o, "cols", c);
            let r = v8::Integer::new_from_unsigned(scope, rows).into();
            set(scope, o, "rows", r);
            if let Some(t) = theme {
                let t = v8::String::new(scope, &t).unwrap().into();
                set(scope, o, "theme", t);
            }
            rv.set(o.into());
        }
        None => rv.set(v8::null(scope).into()),
    }
}
/// The model to draw, as JSON (the window draws the last one it was given after this turn of JS).
fn gui_draw(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let json = arg_str(scope, &args, 0);
    bridge::with(|b| b.model = Some(json));
}
/// An action for the window: bell, clipboard TEXT, iconify, raise.
fn gui_action(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let name = arg_str(scope, &args, 0);
    let arg = if args.length() > 1 {
        arg_str(scope, &args, 1)
    } else {
        String::new()
    };
    bridge::with(|b| b.actions.push((name, arg)));
}
/// The system clipboard's text, or null.
fn gui_clipboard(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    match bridge::clipboard_text() {
        Some(t) => ret_str(scope, &mut rv, &t),
        None => rv.set(v8::null(scope).into()),
    }
}
fn args(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let argv = v8::Array::new(scope, 0);
    for (i, a) in std::env::args().skip(1).enumerate() {
        let v = v8::String::new(scope, &a).unwrap();
        argv.set_index(scope, i as u32, v.into());
    }
    rv.set(argv.into());
}

/// Every native, by its name on __n. The startup snapshot refers to them by their place in this list, so the
/// binary that made it and the one that restores it must agree: both are built from this file. (A macro, as
/// V8 wants each callback as its own zero-sized function item, not a function pointer.)
macro_rules! natives {
    ($m:ident) => {
        $m!(
            "load" load, "args" args, "print" print, "eprint" eprint, "env" env, "cwd" cwd, "now" now,
            "readFile" read_file, "writeFile" write_file, "appendFile" append_file, "stat" stat, "realpath" realpath, "readDir" read_dir,
            "remove" remove, "mkdirs" mkdirs, "lstat" lstat, "rename" rename, "copyTree" copy_tree, "removeDir" remove_dir, "readStdin" read_stdin, "ttyOpen" tty_open, "ttyClose" tty_close,
            "ttyWrite" tty_write, "ttyFlush" tty_flush, "ttySize" tty_size, "suspend" suspend, "exit" exit,
            "sockOpen" sock_open, "sockSend" sock_send, "sockClose" sock_close, "sockError" sock_error, "guiSize" gui_size,
            "guiDraw" gui_draw, "guiAction" gui_action, "guiClipboard" gui_clipboard, "client" client, "edwind" edwind,
            "procSpawn" proc_spawn, "procWrite" proc_write, "procCloseStdin" proc_close_stdin, "procKill" proc_kill, "procList" proc_list,
            "openExternal" open_external, "synLoad" syn_load, "synParse" syn_parse, "synQuery" syn_query, "synFree" syn_free, "synEdit" syn_edit, "synNodes" syn_nodes
        )
    };
}

/// The natives as V8's external references (for making and restoring the snapshot).
pub fn external_refs() -> &'static v8::ExternalReferences {
    static REFS: std::sync::OnceLock<v8::ExternalReferences> = std::sync::OnceLock::new();
    REFS.get_or_init(|| {
        use v8::MapFnTo;
        macro_rules! refs {
            ($($name:literal $f:ident),*) => { vec![$(v8::ExternalReference { function: $f.map_fn_to() }),*] };
        }
        v8::ExternalReferences::new(&natives!(refs))
    })
}

/// Put __n (the natives) and __scm (the shipped Scheme) on the global object.
pub fn install(scope: &mut v8::HandleScope, context: v8::Local<v8::Context>) {
    let n = v8::Object::new(scope);
    macro_rules! put {
        ($($name:literal $f:ident),*) => {$(
            let func = v8::Function::new(scope, $f).unwrap();
            set(scope, n, $name, func.into());
        )*};
    }
    natives!(put);
    let scm = v8::Object::new(scope);
    for (name, text) in sources::SCM {
        let v = v8::String::new(scope, text).unwrap();
        set(scope, scm, name, v.into());
    }
    let g = context.global(scope);
    set(scope, g, "__n", n.into());
    set(scope, g, "__scm", scm.into());
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    /// F's value, F run on the one thread of the test process that runs V8, which sets V8 up first, as main.rs
    /// sets it up on the thread that runs the program. V8's platform takes a memory protection key (PKU, where
    /// the processor has it) for the memory it guards, and only the thread that set it up, and the threads that
    /// thread starts, may read that memory: an isolate made on another test thread faults (SEGV_PKUERR) as it is
    /// made. So every isolate of these tests is made there, one at a time. That thread's thread-locals outlive a
    /// test: syntax::use_dir starts each test's syntax state afresh.
    fn on_v8<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
        type Job = Box<dyn FnOnce() + Send>;
        static V8: std::sync::OnceLock<std::sync::mpsc::Sender<Job>> = std::sync::OnceLock::new();
        let jobs = V8.get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("v8".into())
                .stack_size(96 << 20)
                .spawn(move || {
                    crate::snapshot::init_v8(&crate::ICU_DATA.0);
                    super::start_clock(Instant::now());
                    for job in rx {
                        job();
                    }
                })
                .unwrap();
            tx
        });
        let (tx, rx) = std::sync::mpsc::channel();
        let job = move || {
            let _ = tx.send(std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)));
        };
        jobs.send(Box::new(job)).unwrap();
        match rx.recv().expect("the V8 thread stopped") {
            Ok(v) => v,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    /// Isolates asked for from test threads of their own, one after another and two at once, each run on the V8
    /// thread: none faults for want of the memory protection key V8 set up there.
    #[test]
    fn isolates_from_any_test_thread() {
        let run = |n: i32| {
            on_v8(move || {
                let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
                let scope = &mut v8::HandleScope::new(isolate);
                let context = v8::Context::new(scope, Default::default());
                let scope = &mut v8::ContextScope::new(scope, context);
                let code = v8::String::new(scope, &format!("{n} * 2")).unwrap();
                let v = v8::Script::compile(scope, code, None)
                    .unwrap()
                    .run(scope)
                    .unwrap();
                v.int32_value(scope).unwrap()
            })
        };
        assert_eq!(std::thread::spawn(move || run(1)).join().unwrap(), 2);
        assert_eq!(std::thread::spawn(move || run(2)).join().unwrap(), 4);
        let both = [3, 4].map(|n| std::thread::spawn(move || run(n)));
        assert_eq!(both.map(|t| t.join().unwrap()), [6, 8]);
    }

    /// The tree-sitter natives as JS calls them, on an isolate of its own: the string's indices come back, the
    /// errors are JS errors.
    #[test]
    fn the_syntax_natives_from_javascript() {
        let dir = crate::syntax::tests::bundle();
        let result = on_v8(move || {
            crate::syntax::use_dir(&dir);
            let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
            let scope = &mut v8::HandleScope::new(isolate);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            super::install(scope, context);
            let tc = &mut v8::TryCatch::new(scope);
            let code = v8::String::new(tc, JS).unwrap();
            match v8::Script::compile(tc, code, None).and_then(|s| s.run(tc)) {
                Some(v) => v.to_rust_string_lossy(tc),
                None => tc.exception().unwrap().to_rust_string_lossy(tc),
            }
        });
        assert_eq!(result, "ok");
    }

    const JS: &str = r#"
      const eq = (a, b, what) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)}, not ${JSON.stringify(b)}`);
      };
      const err = f => { try { f(); return 'no error'; } catch (e) { return e instanceof Error ? e.message : 'not an Error'; } };
      eq(__n.synLoad('rust'), ['highlights', 'indents', 'injections', 'tags'], 'kinds');
      const text = 'fn 𝔸() { let é = Foo; }\n';
      const t = __n.synParse('rust', text);
      eq(typeof t, 'number', 'tree');
      const spans = r => {
        const out = [];
        for (let i = 0; i < r.captures.length; i += 4) out.push([r.names[r.captures[i]], text.slice(r.captures[i + 1], r.captures[i + 2])]);
        return out;
      };
      const all = spans(__n.synQuery(t, 'highlights'));
      for (const c of [['keyword', 'fn'], ['function', '𝔸'], ['keyword', 'let'], ['constructor', 'Foo']])
        if (!all.some(s => s[0] === c[0] && s[1] === c[1])) throw new Error(`no ${c} in ${JSON.stringify(all)}`);
      const r = __n.synQuery(t, 'highlights', text.indexOf('Foo'), text.indexOf(';'));
      eq(r.captures.length % 4, 0, 'four numbers a capture');
      eq(spans(r).filter(s => s[0] === 'constructor'), [['constructor', 'Foo']], 'a range');
      // Asked for, a match a capture, one match's captures sharing it: 𝔸's @name and @definition.function.
      const tg = __n.synQuery(t, 'tags', 0, text.length, true);
      eq(tg.matches.length * 4, tg.captures.length, 'a match a capture');
      const first = k => { for (let i = 0; i < tg.captures.length; i += 4) if (tg.names[tg.captures[i]] === k) return i / 4; return -1; };
      eq(text.slice(tg.captures[4 * first('name') + 1], tg.captures[4 * first('name') + 2]), '𝔸', 'the name');
      eq(tg.matches[first('name')], tg.matches[first('definition.function')], 'one match');
      eq('matches' in __n.synQuery(t, 'tags'), false, 'not asked for');
      // The named nodes holding a range, innermost first, as pairs of the string's indices: é, its let, the block.
      const ns = __n.synNodes(t, text.indexOf('é'), text.indexOf('é') + 1), steps = [];
      for (let i = 0; i < ns.length; i += 2) steps.push(text.slice(ns[i], ns[i + 1]));
      eq(steps.slice(0, 3), ['é', 'let é = Foo;', '{ let é = Foo; }'], 'the nodes');
      eq(__n.synNodes(t, text.indexOf('é')).slice(0, 2), ns.slice(0, 2), 'an empty range: the node it is inside');
      eq(err(() => __n.synNodes(t, -1, 2)), 'synNodes: start and end are string indices', 'a negative start');
      eq(err(() => __n.synLoad('../rust')), 'no grammar "../rust": a grammar\'s name is letters, digits and _', 'a path');
      eq(err(() => __n.synLoad('nosuch')), 'no grammar nosuch', 'a missing grammar');
      eq(err(() => __n.synParse('rust', 5)), 'synParse: the text is not a string', 'not a string');
      eq(err(() => __n.synQuery(t, 'highlights', -1)), 'synQuery: start and end are string indices', 'a negative start');
      eq(err(() => __n.synQuery(t, 'folds')), 'rust has no "folds" query', 'a kind the bundle lacks');
      // An edit at indices of the JS string: 𝔸 is two of them, and the edit after it moves Foo along.
      const at = text.indexOf('Foo'), edited = text.slice(0, at) + 'Bar' + text.slice(at + 3);
      eq(__n.synEdit(t, at, 3, 'Bar'), undefined, 'an edit');
      const after = __n.synQuery(t, 'highlights'), got = [];
      for (let i = 0; i < after.captures.length; i += 4) got.push([after.names[after.captures[i]], edited.slice(after.captures[i + 1], after.captures[i + 2])]);
      if (!got.some(s => s[0] === 'constructor' && s[1] === 'Bar') || got.some(s => s[1] === 'Foo')) throw new Error(`after the edit: ${JSON.stringify(got)}`);
      eq(err(() => __n.synEdit(t, edited.length, 1, '')), `synEdit: 1 deleted at ${edited.length} goes past syntax tree ${t}'s text of ${edited.length}`, 'past the end');
      eq(err(() => __n.synEdit(t, -1, 0, '')), 'synEdit: the position and the length deleted are string indices', 'a negative position');
      eq(err(() => __n.synEdit(t, 0.5, 0, '')), 'synEdit: the position and the length deleted are string indices', 'a fraction');
      eq(err(() => __n.synEdit(t, 0, 0, 5)), 'synEdit: the text inserted is not a string', 'not a string');
      eq([__n.synFree(t), __n.synFree(t)], [true, false], 'freed once');
      eq(err(() => __n.synEdit(t, 0, 0, 'x')), `no syntax tree ${t}`, 'editing a freed tree');
      eq(err(() => __n.synQuery(t, 'highlights')), `no syntax tree ${t}`, 'a freed tree');
      eq(err(() => __n.synNodes(t, 0, 1)), `no syntax tree ${t}`, 'the nodes of a freed tree');
      'ok'
    "#;

    /// The core booted as the startup snapshot holds it (native/js/boot.ts with the native host and the shipped
    /// Scheme), with the grammar bundle under test, on an isolate of its own; then CODE, its value as a string
    /// or what it threw.
    fn with_core(code: String) -> String {
        let dir = crate::syntax::tests::bundle();
        on_v8(move || {
            crate::syntax::use_dir(&dir);
            let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
            let scope = &mut v8::HandleScope::new(isolate);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            super::install(scope, context);
            for name in [
                "native/prelude",
                "native/host-native",
                "native/term",
                "native/boot",
            ] {
                assert!(super::run_source(scope, name), "{name} failed");
                scope.perform_microtask_checkpoint();
            }
            let tc = &mut v8::TryCatch::new(scope);
            let code = v8::String::new(tc, &code).unwrap();
            match v8::Script::compile(tc, code, None).and_then(|s| s.run(tc)) {
                Some(v) => v.to_rust_string_lossy(tc),
                None => tc.exception().unwrap().to_rust_string_lossy(tc),
            }
        })
    }

    /// Faces from the grammars' highlights queries (src/syntax.ts) as a frame draws them, for each mode of the
    /// bundle: the classes of Ed.renderBuffer's runs for each fixture of test/syntax-faces.txt are its golden
    /// runs; each line drawn alone (a window whose first line is inside a comment or string begun above it) has
    /// the classes it has in the whole; and after edits, the classes are those of a fresh buffer of the same text
    /// (the tree kept in step through the edit log). Every mode scm/prog.scm declares has a fixture.
    #[test]
    fn the_core_highlights_each_language_as_its_golden_runs() {
        let golden = include_str!("../../test/syntax-faces.txt");
        let prog = include_str!("../../scm/prog.scm");
        let code = format!(
            "const GOLDEN = {}, PROG = {};\n{}",
            js_str(golden),
            js_str(prog),
            GOLDEN_JS
        );
        assert_eq!(with_core(code), "ok");
    }

    /// The keystroke budget as a frame meets it: in a text of 10,000 lines (syntax.rs's BLOCKS repeated), a
    /// character typed or taken back in the first, middle or last ten lines, and a window of 60 lines around it
    /// drawn again with its faces (the edit crossing to the tree, its reparse, the window's highlights query,
    /// the classes and the runs), within 2 ms, the median of 50 keystrokes, the best of three such runs. Python
    /// is held to under half of a fresh buffer's first draw instead, as syntax.rs's budget test holds its
    /// reparse to half a whole parse: its reparse is not within 2 ms on a loaded machine. Ignored as that test
    /// is, and run on request the same way, with "a_key_in_10000_lines" in place of its name.
    #[test]
    #[ignore]
    fn a_key_in_10000_lines_redraws_its_faces_within_its_budget() {
        let _alone = crate::syntax::tests::heavy();
        let blocks: Vec<String> = crate::syntax::tests::BLOCKS
            .iter()
            .map(|(name, block, word)| {
                format!("[{}, {}, {}]", js_str(name), js_str(block), js_str(word))
            })
            .collect();
        let out = with_core(format!(
            "const BLOCKS = [{}];\n{}",
            blocks.join(", "),
            BUDGET_JS
        ));
        eprintln!("{out}");
        assert!(out.ends_with("\nok"), "{out}");
    }

    const BUDGET_JS: &str = r#"
      const Ed = globalThis.Ed, report = [];
      const MODE = { rust: 'rust-mode', c: 'c-mode', javascript: 'js-mode', nix: 'nix-mode', python: 'python-mode' };
      let n = 0, ok = true;
      const buffer = (grammar, text) => {
        const b = Ed.getBufferCreate(`budget-${++n}`);
        Ed.replaceText(b, 0, b.rope.length, text);
        Ed.switchMajorMode(b, MODE[grammar]);
        return b;
      };
      const median = v => v.sort((x, y) => x - y)[v.length >> 1];
      for (const [grammar, block, word] of BLOCKS) {
        const text = block.repeat(1000);
        let first = Infinity;
        for (let i = 0; i < 3; i++) {
          const b = buffer(grammar, text), t = performance.now();
          Ed.renderBuffer(b, { from: text.length >> 1, count: 60, runs: true, html: false });
          first = Math.min(first, performance.now() - t);
          globalThis.L.call('kill-buffer', [b]);
        }
        const b = buffer(grammar, text);
        for (const [place, no] of [['first', 0], ['middle', 500], ['last', 999]]) {
          const at = no * block.length + block.indexOf(word) + word.length;
          const o = { from: Math.max(0, at - 30 * 40), count: 60, runs: true, html: false };
          if (!Ed.renderBuffer(b, o).some(l => l.runs.some(r => r.cls === 'kw'))) { ok = false; report.push(`${grammar}: no keyword drawn`); }
          let key = Infinity;
          for (let r = 0; r < 3; r++) {
            const times = [];
            for (let i = 0; i < 50; i++) {
              const t = performance.now();
              if (i % 2 === 0) Ed.replaceText(b, at, at, 'z'); else Ed.replaceText(b, at, at + 1, '');
              Ed.renderBuffer(b, o);
              times.push(performance.now() - t);
            }
            key = Math.min(key, median(times));
          }
          report.push(`${grammar}: a keystroke in the ${place} ten lines of 10,000 and a redraw of 60 lines: ${key.toFixed(3)} ms; a fresh buffer's first draw ${first.toFixed(1)} ms`);
          if (grammar === 'python' ? key * 2 >= first : key > 2) { ok = false; report.push(`${grammar}: over its budget`); }
        }
      }
      report.join('\n') + (ok ? '\nok' : '\nfailed')
    "#;

    /// TEXT as a JavaScript string literal.
    fn js_str(text: &str) -> String {
        let mut out = String::from("\"");
        for c in text.encode_utf16() {
            match c {
                0x22 => out.push_str("\\\""),
                0x5c => out.push_str("\\\\"),
                0x20..=0x7e => out.push(c as u8 as char),
                _ => out.push_str(&format!("\\u{c:04x}")),
            }
        }
        out.push('"');
        out
    }

    const GOLDEN_JS: &str = r#"
      const Ed = globalThis.Ed;
      if (!Ed.host.syntax) throw new Error('the native host has no syntax');
      /* The fixtures: "=== MODE", its text, "---", then one "CLASS<tab>TEXT" line a run with a face. */
      const fixtures = [];
      for (const part of GOLDEN.split(/^=== /m).slice(1)) {
        const nl = part.indexOf('\n'), mode = part.slice(0, nl).trim(), rest = part.slice(nl + 1);
        const sep = rest.indexOf('\n---\n');
        if (sep < 0) throw new Error(`${mode}: no ---`);
        const want = rest.slice(sep + 5).split('\n').filter(l => l && !l.startsWith('#'));
        fixtures.push({ mode, text: rest.slice(0, sep + 1), want });
      }
      const modes = [...PROG.matchAll(/^\(define-language (\S+) /gm)].map(m => m[1]);
      const have = fixtures.map(f => f.mode);
      if (JSON.stringify([...modes].sort()) !== JSON.stringify([...have].sort()))
        throw new Error(`modes ${modes} but fixtures for ${have}`);
      let n = 0;
      const buffer = (mode, text) => {
        const b = Ed.getBufferCreate(`golden-${++n}`);
        Ed.replaceText(b, 0, b.rope.length, text);
        Ed.switchMajorMode(b, mode);
        b.pt = b.rope.length;
        return b;
      };
      /* The faced runs of lines FROM (a position) on, COUNT of them: [class, text] each. */
      const runs = (b, from = 0, count = 100000) => {
        const out = [];
        for (const l of Ed.renderBuffer(b, { from, count, runs: true, html: false }))
          for (const r of l.runs) if (!r.k && r.cls) out.push([r.cls, l.text.slice(r.s, r.e)]);
        return out;
      };
      const lines = b => Ed.renderBuffer(b, { from: 0, count: 100000, runs: true, html: false });
      const errors = [];
      for (const f of fixtures) {
        const b = buffer(f.mode, f.text);
        if (b.mode !== f.mode) { errors.push(`${f.mode}: the buffer is in ${b.mode}`); continue; }
        const got = runs(b).map(([c, t]) => `${c}\t${t}`);
        if (JSON.stringify(got) !== JSON.stringify(f.want))
          errors.push(`${f.mode}: the runs are\n${got.join('\n')}`);
        /* Each line drawn as a window's first line. */
        const whole = lines(b);
        for (const l of whole) {
          const alone = Ed.renderBuffer(b, { from: l.o, count: 1, runs: true, html: false })[0];
          if (JSON.stringify(alone.runs) !== JSON.stringify(l.runs)) errors.push(`${f.mode}: line at ${l.o} drawn alone differs`);
        }
        /* Edits: a line typed in the middle a character at a time, a line deleted, an edit undone by hand. */
        const mid = f.text.indexOf('\n', f.text.length >> 1) + 1;
        for (const ch of 'x = 1;\n') { Ed.replaceText(b, mid, mid, ch); runs(b, 0, 3); }
        runs(b);
        Ed.replaceText(b, mid, mid + 7, '');
        const first = b.rope.indexOf('\n') + 1;
        Ed.replaceText(b, 0, first, '');
        runs(b);
        Ed.replaceText(b, 0, 0, f.text.slice(0, first));
        const after = runs(b), fresh = runs(buffer(f.mode, b.rope.toString()));
        if (b.rope.toString() !== f.text) errors.push(`${f.mode}: the edits did not give the text back`);
        if (JSON.stringify(after) !== JSON.stringify(fresh)) errors.push(`${f.mode}: after edits the runs differ from a fresh buffer's`);
      }
      errors.length ? errors.join('\n\n') : 'ok'
    "#;

    /// Imenu from the grammars' tags queries (Ed.syntax.imenu, src/syntax.ts), for each mode of the bundle
    /// whose grammar has one: the definitions of each fixture of test/syntax-imenu.txt, as KIND, NAME and line,
    /// are its golden list. Every such mode has a fixture, and no other mode does.
    #[test]
    fn the_core_lists_each_languages_definitions_as_its_golden_imenu() {
        let golden = include_str!("../../test/syntax-imenu.txt");
        let prog = include_str!("../../scm/prog.scm");
        let code = format!(
            "const GOLDEN = {}, PROG = {};\n{}",
            js_str(golden),
            js_str(prog),
            IMENU_JS
        );
        assert_eq!(with_core(code), "ok");
    }

    const IMENU_JS: &str = r#"
      const Ed = globalThis.Ed;
      /* The fixtures: "=== MODE", its text, "---", then one "KIND<tab>NAME<tab>LINE" line a definition. */
      const fixtures = [];
      for (const part of GOLDEN.split(/^=== /m).slice(1)) {
        const nl = part.indexOf('\n'), mode = part.slice(0, nl).trim(), rest = part.slice(nl + 1);
        const sep = rest.indexOf('\n---\n');
        if (sep < 0) throw new Error(`${mode}: no ---`);
        const want = rest.slice(sep + 5).split('\n').filter(l => l && !l.startsWith('#'));
        fixtures.push({ mode, text: rest.slice(0, sep + 1), want });
      }
      const modes = [...PROG.matchAll(/^\(define-language (\S+) /gm)].map(m => m[1])
        .filter(m => globalThis.__n.synLoad(Ed.syntax.grammarOf(m)).includes('tags'));
      const have = fixtures.map(f => f.mode);
      if (JSON.stringify([...modes].sort()) !== JSON.stringify([...have].sort()))
        throw new Error(`modes with tags ${modes} but fixtures for ${have}`);
      const errors = [];
      let n = 0;
      for (const f of fixtures) {
        const b = Ed.getBufferCreate(`imenu-${++n}`);
        Ed.replaceText(b, 0, b.rope.length, f.text);
        Ed.switchMajorMode(b, f.mode);
        const items = Ed.syntax.imenu(b);
        if (!items) { errors.push(`${f.mode}: no items`); continue; }
        const got = items.map(it => `${it.kind}\t${it.name}\t${Ed.lineNo(b.rope, it.pos)}`);
        if (JSON.stringify(got) !== JSON.stringify(f.want)) errors.push(`${f.mode}: the definitions are\n${got.join('\n')}`);
      }
      errors.length ? errors.join('\n\n') : 'ok'
    "#;

    /// The fixtures of test/fixtures/syntax-indent, each as its formatter left it (rustfmt, gofmt, clang-format,
    /// prettier, alejandra), as a JavaScript object of mode to text.
    fn indent_fixtures() -> String {
        let files = [
            ("rust-mode", include_str!("../../test/fixtures/syntax-indent/rust.rs")),
            ("go-mode", include_str!("../../test/fixtures/syntax-indent/go.go")),
            ("c-mode", include_str!("../../test/fixtures/syntax-indent/c.c")),
            ("json-mode", include_str!("../../test/fixtures/syntax-indent/json.json")),
            ("js-mode", include_str!("../../test/fixtures/syntax-indent/javascript.js")),
            ("typescript-mode", include_str!("../../test/fixtures/syntax-indent/typescript.ts")),
            ("tsx-mode", include_str!("../../test/fixtures/syntax-indent/tsx.tsx")),
            ("nix-mode", include_str!("../../test/fixtures/syntax-indent/nix.nix")),
        ];
        let body: Vec<String> = files.iter().map(|(m, t)| format!("{}: {}", js_str(m), js_str(t))).collect();
        format!("{{{}}}", body.join(", "))
    }

    /// The indent engine (Ed.syntax.indent, src/syntax.ts) with the real grammars and the bundle's indents
    /// queries: re-indenting each formatted fixture changes nothing (no edit at all); the fixture with its
    /// blanks taken away (but in the lines the rules keep: strings and comments begun above) comes back,
    /// re-indented as a region and line by line from the top; and RET (evil-newline-and-indent) after {, ( and
    /// a closing brace, with the bracket's pair after point (electric-pair-mode) and without, puts the new line
    /// at the column of the language's formatter.
    #[test]
    fn the_core_indents_each_language_as_its_formatter() {
        let code = format!("const FIXTURES = {};\n{}", indent_fixtures(), INDENT_JS);
        assert_eq!(with_core(code), "ok");
    }

    const INDENT_JS: &str = r#"
      const Ed = globalThis.Ed, S = globalThis.Scheme;
      const errors = [];
      let n = 0;
      const buffer = (mode, text) => {
        const b = Ed.getBufferCreate(`indent-${++n}`);
        Ed.replaceText(b, 0, b.rope.length, text);
        Ed.switchMajorMode(b, mode);
        Ed.setWindowBuffer(b);
        return b;
      };
      const firstDiff = (a, b) => {
        const x = a.split('\n'), y = b.split('\n');
        const i = x.findIndex((l, k) => l !== y[k]);
        return `line ${i + 1}: ${JSON.stringify(x[i])}, not ${JSON.stringify(y[i])}`;
      };
      for (const [mode, text] of Object.entries(FIXTURES)) {
        const b = buffer(mode, text), ver = b.ver;
        b.modified = false;
        const want = Ed.syntax.indents(b, 0, text.length);
        if (!want) { errors.push(`${mode}: no indent rules`); continue; }
        if (Ed.syntax.indent(b, 0, text.length, false) === null) errors.push(`${mode}: no indent rules`);
        if (b.ver !== ver || b.modified || b.rope.toString() !== text)
          errors.push(`${mode}: re-indenting the formatted text changed it: ${firstDiff(b.rope.toString(), text)}`);
        /* Its blanks taken away but where the rules keep them. */
        const lines = text.split('\n');
        const bare = lines.map((l, i) => want.want[i] === null ? l : l.replace(/^[ \t]+/, '')).join('\n');
        const r = buffer(mode, bare);
        Ed.syntax.indent(r, 0, bare.length, false);
        if (r.rope.toString() !== text) errors.push(`${mode}: re-indenting the bare text as a region: ${firstDiff(r.rope.toString(), text)}`);
        const l = buffer(mode, bare);
        for (let ls = 0; ls < l.rope.length; ls = Ed.eol(l.rope, ls) + 1) Ed.syntax.indent(l, ls, ls, false);
        if (l.rope.toString() !== text) errors.push(`${mode}: re-indenting the bare text line by line: ${firstDiff(l.rope.toString(), text)}`);
      }
      /* gofmt's output the bare text cannot bring back: a comment after a case's statements at their level (gofmt
         keeps it there or at the case's), which re-indenting leaves where it is. */
      const KEPT = [
        ['go-mode', 'package main\n\nfunc f(x int) {\n\tswitch x {\n\tcase 1:\n\t\tg()\n\t\t// still one\n\tcase 2:\n\t\th()\n\t// before the default\n\tdefault:\n\t}\n}\n'],
      ];
      for (const [mode, text] of KEPT) {
        const b = buffer(mode, text);
        Ed.syntax.indent(b, 0, text.length, false);
        if (b.rope.toString() !== text) errors.push(`${mode}: re-indenting gofmt's comments changed them: ${firstDiff(b.rope.toString(), text)}`);
      }
      /* [mode, text with | for point, the blanks of the line point is on after RET, those of the line after it
         or null] */
      const CASES = [
        ['rust-mode', 'fn main() {|', '    ', null],
        ['rust-mode', 'fn main() {|}', '    ', ''],
        ['rust-mode', 'fn main() {\n    let x = foo(|', '        ', null],
        ['rust-mode', 'fn main() {\n    let x = foo(|)\n}\n', '        ', '    '],
        ['rust-mode', 'fn main() {\n    if a {\n        b\n    }|', '    ', null],
        ['rust-mode', 'fn main() {\n    if a {\n        b\n    }|\n}\n', '    ', ''],
        ['rust-mode', 'fn a() {\n}|\nfn b() {}\n', '', ''],
        ['rust-mode', 'fn main() {\n    match x {|}\n}\n', '        ', '    '],
        ['rust-mode', 'impl A {\n    fn f(&self) {|\n}\n', '        ', ''],
        ['rust-mode', 'fn f() {\n    let Some(y) = x else {|\n}\n', '        ', ''],
        ['rust-mode', 'fn f() {\n    let n = items\n        .iter()\n        .then(async {|});\n}\n', '            ', '        '],
        ['go-mode', 'func main() {|', '\t', null],
        ['go-mode', 'func main() {|}', '\t', ''],
        ['go-mode', 'func main() {\n\tx := foo(|)\n}\n', '\t\t', '\t'],
        ['go-mode', 'func main() {\n\tswitch x {|}\n}\n', '\t', '\t'],
        ['go-mode', 'func main() {\n\tswitch x {\n\tcase 1:|\n\t}\n}\n', '\t\t', '\t'],
        ['go-mode', 'func main() {\n\tif a {\n\t\tb()\n\t}|', '\t', null],
        ['c-mode', 'int main(void) {|}', '    ', ''],
        ['c-mode', 'int main(void) {\n    foo(|', '        ', null],
        ['c-mode', 'int main(void) {\n    if (a) {\n        b();\n    }|', '    ', null],
        ['c-mode', 'int main(void) {\n    if (a &&\n        (b +\n         c)) {|}\n}\n', '        ', '    '],
        ['c-mode', 'int main(void) {\n    switch (x) {|}\n}\n', '    ', '    '],
        ['c-mode', 'int main(void) {\n    switch (x) {\n    case 1:|\n    }\n}\n', '        ', '    '],
        ['json-mode', '{|}', '  ', ''],
        ['json-mode', '{\n  "a": [|', '    ', null],
        ['json-mode', '{\n  "a": [\n    1\n  ]|', '  ', null],
        ['typescript-mode', 'function f() {|}', '  ', ''],
        ['typescript-mode', 'function f() {\n  const x = foo(|', '    ', null],
        ['typescript-mode', 'function f() {\n  if (a) {\n    b();\n  }|', '  ', null],
        ['typescript-mode', 'class A {|}', '  ', ''],
        ['typescript-mode', 'function f() {\n  if (a)|\n}\n', '    ', ''],
        ['typescript-mode', 'function f() {\n  const x = items\n    .map((y) => {|});\n}\n', '      ', '    '],
        ['js-mode', 'function f() {\n  return [|]\n}\n', '    ', '  '],
        ['js-mode', 'switch (x) {\n  case 1:|\n}\n', '    ', ''],
        ['tsx-mode', 'const a = (\n  <div>|', '    ', null],
        ['tsx-mode', 'const a = (\n  <div>\n    <p>x</p>|\n  </div>\n);\n', '    ', '  '],
      ];
      const blanks = l => l.slice(0, l.length - l.trimStart().length);
      for (const [mode, src, want, after] of CASES) {
        const b = buffer(mode, src.replace('|', ''));
        b.pt = src.indexOf('|');
        S.evalString('(evil-newline-and-indent)');
        const t = b.rope, ls = Ed.bol(t, b.pt), le = Ed.eol(t, b.pt);
        const line = t.slice(ls, le), next = le < t.length ? t.slice(le + 1, Ed.eol(t, le + 1)) : null;
        const got = [blanks(line), after === null ? null : blanks(next ?? '')];
        if (b.pt !== ls + got[0].length) errors.push(`${mode} ${JSON.stringify(src)}: point is not after the blanks`);
        if (got[0] !== want || got[1] !== after) errors.push(`${mode} ${JSON.stringify(src)}: ${JSON.stringify(t.toString())}`);
      }
      errors.length ? errors.join('\n') : 'ok'
    "#;

    /// Ed.syntax.indent over 10,000 lines of Rust (the fixture repeated, its tree parsed first): the whole
    /// re-indent, with no change to make, within a second; and with an unclosed `fn g() { let x = (` typed at
    /// the top (the tree's errors reaching to the end), one line in the middle indented within 200 ms and the
    /// whole re-indent (gg=G in a file with one unclosed bracket) within a second too, so that the cost of an
    /// ERROR stays about linear in its length (each ERROR's brackets queried once a re-indent, not once a line, and
    /// no query over one line inside it for the lines asked for).
    /// The bounds are loose for a loaded build host; a failure names the times.
    #[test]
    fn the_core_reindents_ten_thousand_lines_in_a_second() {
        let code = format!("const FIXTURES = {};\n{}", indent_fixtures(), INDENT_BIG_JS);
        let got = with_core(code);
        let ms: Vec<f64> = got.split(' ').map(|m| m.parse().unwrap_or_else(|_| panic!("{got}"))).collect();
        assert!(ms.len() == 3 && ms[0] < 1000.0 && ms[1] < 200.0 && ms[2] < 1000.0, "{got} ms");
    }

    const INDENT_BIG_JS: &str = r#"
      const Ed = globalThis.Ed, one = FIXTURES['rust-mode'];
      const text = one.repeat(Math.ceil(10000 / one.split('\n').length));
      const b = Ed.getBufferCreate('indent-big');
      Ed.replaceText(b, 0, b.rope.length, text);
      Ed.switchMajorMode(b, 'rust-mode');
      Ed.syntax.tree(b, 'rust');
      const ver = b.ver, t0 = Date.now();
      Ed.syntax.indent(b, 0, text.length, false);
      const ms = Date.now() - t0, changed = b.ver !== ver;
      Ed.replaceText(b, 0, 0, 'fn g() {\n    let x = (\n');
      Ed.syntax.tree(b, 'rust');
      const mid = Ed.bol(b.rope, Math.floor(b.rope.length / 2)), t1 = Date.now();
      Ed.syntax.indent(b, mid, mid, true);
      const line = Date.now() - t1, t2 = Date.now();
      Ed.syntax.indent(b, 0, b.rope.length, false);
      const all = Date.now() - t2;
      changed ? `the re-indent changed the text` : `${ms} ${line} ${all}`
    "#;

    /// Nix's indentation (nix/indents/nix.scm) with the real grammar, beside the fixture the test above re-indents:
    /// the content of '' strings is never re-indented (gg=G over text whose other lines lost their blanks gives
    /// alejandra's layout back with every string as it was, interpolations at odd depths too, and so does a
    /// re-indent of each line on its own); RET, o and TAB give the new line alejandra's blanks, complete text and
    /// half-typed; and 10,000 lines of the fixture in a list re-indent within a second, and with an unclosed
    /// `{ a = (` typed at the top one line within 200 ms and the whole within a second.
    #[test]
    fn the_core_indents_nix_as_alejandra() {
        let code = format!(
            "const FIXTURE = {};\n{}",
            js_str(include_str!("../../test/fixtures/syntax-indent/nix.nix")),
            NIX_JS
        );
        assert_eq!(with_core(code), "ok");
    }

    const NIX_JS: &str = r#"
      const Ed = globalThis.Ed, S = globalThis.Scheme;
      const errors = [];
      let n = 0;
      const buffer = text => {
        const b = Ed.getBufferCreate(`nix-${++n}`);
        Ed.replaceText(b, 0, b.rope.length, text);
        Ed.switchMajorMode(b, 'nix-mode');
        Ed.setWindowBuffer(b);
        return b;
      };
      const firstDiff = (a, b) => {
        const x = a.split('\n'), y = b.split('\n');
        const i = x.findIndex((l, k) => l !== y[k]);
        return `line ${i + 1}: ${JSON.stringify(x[i])}, not ${JSON.stringify(y[i])}`;
      };
      /* '' strings whose lines the rules would move if they applied: blanks at no level, an interpolation holding
         an attribute set and another '' string, each at odd depths. BARE is the text with the blanks of the lines
         outside the strings taken away (named here, not found by the rules). */
      const STRINGS = [
        '{',
        "  a = ''",
        '      odd',
        '    ${',
        '          {b = 1;}.b',
        '    }',
        '     x',
        "  '';",
        "  b = ps: ''",
        '  low',
        "        ${lib.concatMapStrings (p: ''",
        '    deep ${p}',
        "  '') ps}",
        '   end',
        "  '';",
        '}',
        '',
      ].join('\n');
      const OUTSIDE = new Set([0, 1, 8, 15]);
      const bare = STRINGS.split('\n').map((l, i) => OUTSIDE.has(i) ? l.trimStart() : l).join('\n');
      const s = buffer(bare);
      Ed.syntax.indent(s, 0, bare.length, false);
      if (s.rope.toString() !== STRINGS) errors.push(`gg=G around '' strings: ${firstDiff(s.rope.toString(), STRINGS)}`);
      const each = buffer(STRINGS);
      for (let ls = 0; ls < each.rope.length; ls = Ed.eol(each.rope, ls) + 1) Ed.syntax.indent(each, ls, ls, false);
      if (each.rope.toString() !== STRINGS) errors.push(`= on each line around '' strings: ${firstDiff(each.rope.toString(), STRINGS)}`);
      /* [text with | for point, the text after the keys with | for point] */
      const RET = [
        ['{|}', '{\n  |\n}'],
        ['{\n  a = {|', '{\n  a = {\n    |'],
        ['{\n  a = 1;|\n}', '{\n  a = 1;\n  |\n}'],
        ['{\n  a = {\n    b = 1;|\n}', '{\n  a = {\n    b = 1;\n    |\n}'],
        ['{\n  imports = [\n    ./a.nix\n  ];|\n}', '{\n  imports = [\n    ./a.nix\n  ];\n  |\n}'],
        ['{\n  a = [|]', '{\n  a = [\n    |\n  ]'],
        ['{\n  a = [\n    1|\n  ];\n}', '{\n  a = [\n    1\n    |\n  ];\n}'],
        ['{\n  a =|\n}', '{\n  a =\n    |\n}'],
        ['{\n  a = x:|\n}', '{\n  a = x:\n    |\n}'],
        ['{\n  a = f (x: {|});\n}', '{\n  a = f (x: {\n    |\n  });\n}'],
        ['{\n  a = with pkgs; [|]\n}', '{\n  a = with pkgs; [\n    |\n  ]\n}'],
        ['{\n  a =\n    if b\n    then c|\n}', '{\n  a =\n    if b\n    then c\n    |\n}'],
        ["{\n  a = ''\n    foo|\n  '';\n}", "{\n  a = ''\n    foo\n    |\n  '';\n}"],
        ['{\n  # c|\n  a = 1;\n}', '{\n  # c\n  |\n  a = 1;\n}'],
        ['{pkgs, ...}:|', '{pkgs, ...}:\n|'],
        ['{pkgs, ...}: {|}', '{pkgs, ...}: {\n  |\n}'],
        ['let|', 'let\n  |'],
        ['let\n  a = 1;|', 'let\n  a = 1;\n  |'],
        ['let\n  a = 1;\nin|', 'let\n  a = 1;\nin\n  |'],
        ['let\n  a = 1;\nin {|}', 'let\n  a = 1;\nin {\n  |\n}'],
        ['{\n  a = let\n    b = 1;\n  in|\n}', '{\n  a = let\n    b = 1;\n  in\n    |\n}'],
      ];
      const run = (src, form) => {
        const c = buffer(src.replace('|', ''));
        c.pt = src.indexOf('|');
        S.evalString(form);
        return c.rope.slice(0, c.pt) + '|' + c.rope.slice(c.pt, c.rope.length);
      };
      for (const [src, want] of RET) {
        const got = run(src, '(evil-newline-and-indent)');
        if (got !== want) errors.push(`RET in ${JSON.stringify(src)}: ${JSON.stringify(got)}`);
      }
      for (const [src, want] of [
        ['{\n  a = 1;|\n  b = 2;\n}', '{\n  a = 1;\n  |\n  b = 2;\n}'],
        ['{\n  a = {|\n    b = 1;\n  };\n}', '{\n  a = {\n    |\n    b = 1;\n  };\n}'],
      ]) {
        const got = run(src, '(evil-open-below 1)');
        if (got !== want) errors.push(`o in ${JSON.stringify(src)}: ${JSON.stringify(got)}`);
      }
      for (const [src, want] of [
        ['{\na = 1;|\n}', '{\n  a = 1;|\n}'],
        ['{\n  a = [\n1|\n  ];\n}', '{\n  a = [\n    1|\n  ];\n}'],
      ]) {
        const got = run(src, '(indent-for-tab-command)');
        if (got !== want) errors.push(`TAB in ${JSON.stringify(src)}: ${JSON.stringify(got)}`);
      }
      /* 10,000 lines: the fixture's expression, many times, each the value of an attribute (laid out by a first
         re-indent). */
      const body = FIXTURE.slice(FIXTURE.indexOf('\n') + 1).trimEnd(), count = Math.ceil(10000 / body.split('\n').length);
      const big = buffer('{\n' + Array.from({ length: count }, (_, i) => `a${i} = ${body};\n`).join('') + '}\n');
      Ed.syntax.indent(big, 0, big.rope.length, false);
      const ver = big.ver, t0 = Date.now();
      Ed.syntax.indent(big, 0, big.rope.length, false);
      const ms = Date.now() - t0, changed = big.ver !== ver;
      Ed.replaceText(big, 0, 0, '{\n  a = (\n');
      Ed.syntax.tree(big, 'nix');
      const mid = Ed.bol(big.rope, Math.floor(big.rope.length / 2)), t1 = Date.now();
      Ed.syntax.indent(big, mid, mid, true);
      const line = Date.now() - t1, t2 = Date.now();
      Ed.syntax.indent(big, 0, big.rope.length, false);
      const all = Date.now() - t2;
      if (changed) errors.push('re-indenting 10,000 laid-out lines changed them');
      if (big.rope.toString().split('\n').length < 10000) errors.push('fewer than 10,000 lines');
      if (!(ms < 1000 && line < 200 && all < 1000)) errors.push(`10,000 lines: ${ms} ms, one line with an unclosed { ${line} ms, all ${all} ms`);
      errors.length ? errors.join('\n') : 'ok'
    "#;

    /// Python's indentation (nix/indents/python.scm and the offside rules of src/syntax.ts) with the real grammar:
    /// the black-formatted fixture re-indents to itself with no edit; with the blanks of the lines inside brackets
    /// taken away it comes back (a statement's blanks are what the tree is parsed from, so they are not taken
    /// away); statement lines at a level Python does not take there go to the likeliest; RET after a `:`, inside
    /// brackets, after return and pass and on a typed else, except or case, and `o`, give the new line (and the
    /// line left) black's blanks; TAB after TAB goes a level down and back to the top; and 10,000 lines of the
    /// fixture re-indent within a second.
    #[test]
    fn the_core_indents_python_as_black() {
        let code = format!(
            "const FIXTURE = {};\n{}",
            js_str(include_str!("../../test/fixtures/syntax-indent/python.py")),
            PYTHON_JS
        );
        assert_eq!(with_core(code), "ok");
    }

    const PYTHON_JS: &str = r#"
      const Ed = globalThis.Ed, S = globalThis.Scheme;
      const errors = [];
      let n = 0;
      const buffer = text => {
        const b = Ed.getBufferCreate(`python-${++n}`);
        Ed.replaceText(b, 0, b.rope.length, text);
        Ed.switchMajorMode(b, 'python-mode');
        Ed.setWindowBuffer(b);
        return b;
      };
      const firstDiff = (a, b) => {
        const x = a.split('\n'), y = b.split('\n');
        const i = x.findIndex((l, k) => l !== y[k]);
        return `line ${i + 1}: ${JSON.stringify(x[i])}, not ${JSON.stringify(y[i])}`;
      };
      const b = buffer(FIXTURE), ver = b.ver;
      b.modified = false;
      if (Ed.syntax.indent(b, 0, FIXTURE.length, false) === null) errors.push('no indent rules');
      if (b.ver !== ver || b.modified || b.rope.toString() !== FIXTURE)
        errors.push(`re-indenting black's text changed it: ${firstDiff(b.rope.toString(), FIXTURE)}`);
      /* The lines that begin inside a bracket, outside strings: a count of open brackets at each line's start. */
      const inside = [];
      for (let i = 0, depth = 0, q = null; i < FIXTURE.length; i++) {
        if (i === 0 || FIXTURE[i - 1] === '\n') inside.push(depth > 0 && q === null);
        const c = FIXTURE[i];
        if (q !== null) { if (FIXTURE.startsWith(q, i)) { i += q.length - 1; q = null; } else if (c === '\\') i++; continue; }
        if (c === '#') { while (i + 1 < FIXTURE.length && FIXTURE[i + 1] !== '\n') i++; continue; }
        if (c === '"' || c === "'") { q = FIXTURE.startsWith(c.repeat(3), i) ? c.repeat(3) : c; i += q.length - 1; continue; }
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
      }
      const bare = FIXTURE.split('\n').map((l, i) => inside[i] ? l.trimStart() : l).join('\n');
      if (bare === FIXTURE) errors.push('nothing taken away');
      const r = buffer(bare);
      Ed.syntax.indent(r, 0, bare.length, false);
      if (r.rope.toString() !== FIXTURE) errors.push(`re-indenting the bracket lines as a region: ${firstDiff(r.rope.toString(), FIXTURE)}`);
      const l = buffer(bare);
      for (let ls = 0; ls < l.rope.length; ls = Ed.eol(l.rope, ls) + 1) Ed.syntax.indent(l, ls, ls, false);
      if (l.rope.toString() !== FIXTURE) errors.push(`re-indenting the bracket lines line by line: ${firstDiff(l.rope.toString(), FIXTURE)}`);
      /* [text, the text re-indented]: a statement's blanks that Python does not take there go to the likeliest. */
      const FIX = [
        ['def f():\nx = 1\n', 'def f():\n    x = 1\n'],
        ['def f():\n    x = 1\n      y = 2\n', 'def f():\n    x = 1\n    y = 2\n'],
        ['if a:\n    b\n  c\n', 'if a:\n    b\n    c\n'],
        ['if a:\n    b\n    else:\n        c\n', 'if a:\n    b\nelse:\n    c\n'],
        ['def f():\n    return 1\n        x = 2\n', 'def f():\n    return 1\nx = 2\n'],
        ['x = 1 + \\\n2\n', 'x = 1 + \\\n    2\n'],
        ['x = 1 + \\\n        2\n', 'x = 1 + \\\n        2\n'],
        ['from x import a, \\\n        b\n', 'from x import a, \\\n        b\n'],
        ['from x import a, \\\nb\n', 'from x import a, \\\n    b\n'],
        ['with a as b, \\\n     c as d:\n    pass\n', 'with a as b, \\\n     c as d:\n    pass\n'],
        ['with a as b, \\\nc as d:\npass\n', 'with a as b, \\\n    c as d:\n    pass\n'],
        ['from __future__ import (\nannotations,\n)\n', 'from __future__ import (\n    annotations,\n)\n'],
        ['if a:\n  if b:\n    c\n  d\ne\n', 'if a:\n  if b:\n    c\n  d\ne\n'],
        ['if a:\n\tb\n\tif c:\n\t\td\n\te\n', 'if a:\n\tb\n\tif c:\n\t\td\n\te\n'],
      ];
      for (const [text, want] of FIX) {
        const f = buffer(text);
        Ed.syntax.indent(f, 0, text.length, false);
        if (f.rope.toString() !== want) errors.push(`${JSON.stringify(text)}: ${JSON.stringify(f.rope.toString())}`);
      }
      /* [text with | for point, the text after RET with | for point] */
      const CASES = [
        ['def f():|', 'def f():\n    |'],
        ['class A:\n    def f(self):|', 'class A:\n    def f(self):\n        |'],
        ['def f():\n    x = 1|', 'def f():\n    x = 1\n    |'],
        ['def f():\n    return 1|', 'def f():\n    return 1\n|'],
        ['def f():\n    if a:\n        return 1|', 'def f():\n    if a:\n        return 1\n    |'],
        ['for x in y:\n    pass|', 'for x in y:\n    pass\n|'],
        ['while a:\n    if b:\n        break|', 'while a:\n    if b:\n        break\n    |'],
        ['def f():\n    raise E(\n        "x"\n    )|', 'def f():\n    raise E(\n        "x"\n    )\n|'],
        ['x = foo(|)', 'x = foo(\n    |\n)'],
        ['x = [|]', 'x = [\n    |\n]'],
        ['def f():\n    x = foo(a,|', 'def f():\n    x = foo(a,\n        |'],
        ['x = foo(a,|b)', 'x = foo(a,\n        |b)'],
        ['items = [\n    1,|\n]\n', 'items = [\n    1,\n    |\n]\n'],
        ['def f(\n    a,\n):|', 'def f(\n    a,\n):\n    |'],
        ['if a:\n    b\n    else:|', 'if a:\n    b\nelse:\n    |'],
        ['try:\n    a()\n    except E:|', 'try:\n    a()\nexcept E:\n    |'],
        ['if a:\n    if b:\n        c\n        else:|', 'if a:\n    if b:\n        c\n    else:\n        |'],
        ['match x:\n    case 1:\n        a\n        case 2:|', 'match x:\n    case 1:\n        a\n    case 2:\n        |'],
        ['x = 1 + \\|', 'x = 1 + \\\n    |'],
        ['def f():\n    """Doc|"""', 'def f():\n    """Doc\n    |"""'],
        ['def f():\n    x = 1|  # c', 'def f():\n    x = 1\n    |# c'],
      ];
      const run = (src, form) => {
        const c = buffer(src.replace('|', ''));
        c.pt = src.indexOf('|');
        S.evalString(form);
        return c.rope.slice(0, c.pt) + '|' + c.rope.slice(c.pt, c.rope.length);
      };
      for (const [src, want] of CASES) {
        const got = run(src, '(evil-newline-and-indent)');
        if (got !== want) errors.push(`RET in ${JSON.stringify(src)}: ${JSON.stringify(got)}`);
      }
      for (const [src, want] of [
        ['def f():\n    return 1|', 'def f():\n    return 1\n|'],
        ['def f():\n    if a:|\n        b', 'def f():\n    if a:\n        |\n        b'],
      ]) {
        const got = run(src, '(evil-open-below 1)');
        if (got !== want) errors.push(`o in ${JSON.stringify(src)}: ${JSON.stringify(got)}`);
      }
      /* TAB, then TAB again: the likeliest level, then each level down, then the top again. */
      const tabs = (src, count) => {
        const c = buffer(src.replace('|', ''));
        c.pt = src.indexOf('|');
        const out = [];
        for (let i = 0; i < count; i++) {
          S.evalString('(indent-for-tab-command)');
          S.evalString("(set! last-command 'indent-for-tab-command)");
          const ls = Ed.bol(c.rope, c.pt), line = c.rope.slice(ls, Ed.eol(c.rope, ls));
          out.push(line.slice(0, line.length - line.trimStart().length));
        }
        S.evalString("(set! last-command #f)");
        return JSON.stringify(out);
      };
      const TABS = [
        ['def f():\n    if a:\n        b()\n|', 4, ['        ', '    ', '', '        ']],
        ['def f():\n    if a:\n        return\n|', 4, ['    ', '', '        ', '    ']],
        ['if a:\n    if b:\n        c\n        else:|', 3, ['    ', '', '    ']],
        ['def f():\n    x = 1\n    |y = 2', 3, ['    ', '', '    ']],
        ['x = foo(\n|', 2, ['    ', '    ']],
      ];
      for (const [src, count, want] of TABS) {
        const got = tabs(src, count);
        if (got !== JSON.stringify(want)) errors.push(`TAB ${count} times in ${JSON.stringify(src)}: ${got}`);
      }
      /* 10,000 lines: the whole re-indent with nothing to change. */
      const big = FIXTURE.repeat(Math.ceil(10000 / FIXTURE.split('\n').length)), g = buffer(big);
      Ed.syntax.tree(g, 'python');
      const gv = g.ver, t0 = Date.now();
      Ed.syntax.indent(g, 0, big.length, false);
      const ms = Date.now() - t0;
      if (g.ver !== gv) errors.push('the 10,000 lines changed');
      if (ms > 1000) errors.push(`the 10,000 lines took ${ms} ms`);
      errors.length ? errors.join('\n') : 'ok'
    "#;

    /// expreg-expand (SPC v, scm/evil.scm) with the real grammars: from a point, the selections it steps through
    /// are the named nodes around it, then the buffer, each larger than the one before; expreg-contract (SPC V)
    /// gives them back in turn.
    #[test]
    fn expreg_grows_by_the_trees_nodes() {
        assert_eq!(with_core(EXPREG_JS.into()), "ok");
    }

    const EXPREG_JS: &str = r#"
      const Ed = globalThis.Ed, S = globalThis.Scheme, EvilCore = globalThis.EvilCore;
      /* [mode, text, the text point starts on, the selections, as texts] */
      const CASES = [
        ['nix-mode', '{ a = [ 1 2 ]; }\n', '1', ['1', '[ 1 2 ]', 'a = [ 1 2 ];', '{ a = [ 1 2 ]; }', '{ a = [ 1 2 ]; }\n']],
        ['python-mode', 'x = foo(\n  a, "b c")\ny = 2\n', 'b', ['b', 'b c', '"b c"', '(\n  a, "b c")', 'foo(\n  a, "b c")', 'x = foo(\n  a, "b c")', 'x = foo(\n  a, "b c")\ny = 2\n']],
        ['rust-mode', 'fn f() {\n    let x = g(1, 2);\n}\n', '2', ['2', '(1, 2)', 'g(1, 2)', 'let x = g(1, 2);', '{\n    let x = g(1, 2);\n}', 'fn f() {\n    let x = g(1, 2);\n}', 'fn f() {\n    let x = g(1, 2);\n}\n']],
        /* From a closing bracket: the bracket's node, not the word of punctuation ("];", "]);") cutting across nodes. */
        ['nix-mode', '{ a = [ 1 2 ]; }\n', ']', ['[ 1 2 ]', 'a = [ 1 2 ];', '{ a = [ 1 2 ]; }', '{ a = [ 1 2 ]; }\n']],
        ['rust-mode', 'fn f() {\n    g(a[i]);\n}\n', ']', ['a[i]', '(a[i])', 'g(a[i])', 'g(a[i]);', '{\n    g(a[i]);\n}', 'fn f() {\n    g(a[i]);\n}', 'fn f() {\n    g(a[i]);\n}\n']],
      ];
      const sel = b => b.rope.slice(Math.min(b.mark, b.pt), Math.max(b.mark, b.pt) + 1);
      const errors = [];
      let n = 0;
      for (const [mode, text, from, want] of CASES) {
        const b = Ed.getBufferCreate(`expreg-${++n}`);
        Ed.replaceText(b, 0, b.rope.length, text);
        Ed.switchMajorMode(b, mode);
        Ed.setWindowBuffer(b);
        b.pt = text.indexOf(from);
        const got = [];
        for (let i = 0; i < want.length + 2; i++) {
          try { S.evalString('(expreg-expand)'); } catch (e) { const m = S.errorMessage(e); if (!/Nothing larger/.test(m)) got.push(m); break; }
          const s = sel(b);
          if (got.length && s === got[got.length - 1]) break;
          got.push(s);
        }
        if (JSON.stringify(got) !== JSON.stringify(want)) { errors.push(`${mode}: the steps are ${JSON.stringify(got)}`); continue; }
        const back = [];
        for (let i = 1; i < want.length; i++) { S.evalString('(expreg-contract)'); back.push(sel(b)); }
        if (JSON.stringify(back) !== JSON.stringify(want.slice(0, -1).reverse())) errors.push(`${mode}: contracting gives ${JSON.stringify(back)}`);
        S.evalString('(expreg-contract)');
        if (EvilCore.stateOf(b) !== 'normal') errors.push(`${mode}: contracting past the first step leaves ${EvilCore.stateOf(b)} state`);
      }
      errors.length ? errors.join('\n') : 'ok'
    "#;
}
