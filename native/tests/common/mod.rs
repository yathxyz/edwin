//! What the pseudo-terminal and window suites share: edwinclient, and a throwaway edwind to attach it to.

use std::path::Path;

/// edwinclient for a test: a link of that name in DIR to the binary under test, as the package installs it.
pub fn client(dir: &Path) -> String {
    let link = dir.join("edwinclient");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_edwin"), &link).unwrap();
    link.display().to_string()
}

pub fn have_node() -> bool {
    let ok = std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok();
    if !ok {
        eprintln!("skipped: no node");
    }
    ok
}

/// A child killed when dropped, so a failing assertion does not leave edwind running (and the test hanging).
pub struct Helper(pub std::process::Child);
impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// tests/edwind-up.mts: an edwind with one note, a.md. Its socket and notes directory; a line to its standard
/// input makes it print a.md as edwind and the disk have it, and stop.
pub struct EdwindUp {
    node: Helper,
    lines: std::io::Lines<std::io::BufReader<std::process::ChildStdout>>,
    pub socket: String,
    pub notes: String,
}

impl EdwindUp {
    pub fn start() -> EdwindUp {
        use std::io::BufRead;
        let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/edwind-up.mts");
        let mut node = Helper(
            std::process::Command::new("node")
                .arg(&helper)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut lines = std::io::BufReader::new(node.0.stdout.take().unwrap()).lines();
        let info = lines.next().unwrap().unwrap();
        let field = |k: &str| {
            info.split(&format!("\"{k}\":\""))
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap()
                .to_string()
        };
        let (socket, notes) = (field("socket"), field("notes"));
        EdwindUp {
            node,
            lines,
            socket,
            notes,
        }
    }
    /// a.md as edwind and the disk have it, as JSON; edwind stops.
    pub fn finish(mut self) -> String {
        use std::io::Write;
        writeln!(self.node.0.stdin.as_mut().unwrap(), "done").unwrap();
        let after = self.lines.next().unwrap().unwrap();
        let _ = self.node.0.wait();
        after
    }
}
