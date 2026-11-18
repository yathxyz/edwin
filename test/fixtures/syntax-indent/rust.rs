//! A fixture for the indent engine: rustfmt's layout.
use std::collections::{BTreeMap, HashMap};
use std::fmt::{self, Display};

/* A block comment
  over lines,
* kept as written. */
#[derive(Debug, Clone)]
pub struct Config {
    name: String,
    width: usize,
    tags: Vec<(String, u32)>,
}

pub enum Shape {
    Circle { r: f64 },
    Rect(f64, f64),
    Empty,
}

pub trait Area {
    fn area(&self) -> f64;
    fn describe(&self) -> String {
        format!("{:.2}", self.area())
    }
}

impl Area for Shape {
    fn area(&self) -> f64 {
        match self {
            Shape::Circle { r } => std::f64::consts::PI * r * r,
            Shape::Rect(w, h) => {
                let a = w * h;
                a
            }
            Shape::Empty => 0.0,
        }
    }
}

impl Display for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.name, self.width)
    }
}

fn group<K, V>(items: Vec<(K, V)>) -> HashMap<K, Vec<V>>
where
    K: std::hash::Hash + Eq,
{
    let mut out: HashMap<K, Vec<V>> = HashMap::new();
    for (k, v) in items {
        out.entry(k).or_default().push(v);
    }
    out
}

fn long_arguments(
    first_argument_name: &str,
    second_argument_name: usize,
    third_argument_name: Option<&BTreeMap<String, u32>>,
) -> Option<usize> {
    let Some(map) = third_argument_name else {
        return None;
    };
    let total = map
        .values()
        .map(|v| *v as usize)
        .filter(|v| *v > second_argument_name)
        .sum::<usize>();
    // The total, in µs: ≥ 10 𝔸 counts as many.
    if total > 10 && first_argument_name.len() > 3 || second_argument_name == 0 {
        Some(total)
    } else if total == 0 {
        None
    } else {
        Some(total + first_argument_name.len())
    }
}

fn main() {
    let shapes = vec![
        Shape::Circle { r: 1.0 },
        Shape::Rect(2.0, 3.0),
        Shape::Empty,
    ];
    let config = Config {
        name: String::from("edwin"),
        width: 4,
        tags: vec![("a".into(), 1), ("b".into(), 2)],
    };
    let text = "a string
over two lines";
    let raw = r#"
    raw text, "quoted",
        kept as written
"#;
    let areas: Vec<f64> = shapes.iter().map(|s| s.area()).collect();
    let described = shapes
        .iter()
        .map(|s| {
            let d = s.describe();
            d.to_uppercase()
        })
        .collect::<Vec<_>>();
    println!("{} {} {} {:?} {:?}", config, text, raw, areas, described);
    let sum = long_arguments(
        "first",
        2,
        Some(&BTreeMap::from([
            ("x".to_string(), 3),
            ("y".to_string(), 30),
        ])),
    );
    let ok = match sum {
        Some(n) if n > 3 => true,
        Some(_) => false,
        None => {
            eprintln!("nothing");
            false
        }
    };
    let grouped = group(vec![(1, 'a'), (1, 'b'), (2, 'c')]);
    assert!(ok || grouped.len() == 2, "unexpected: {:?}", grouped);
}

fn chains(items: &[Item], text: &str) -> Option<usize> {
    let total = items
        .iter()
        .filter(|item| item.visible && !item.name.is_empty())
        .map(|item| item.width + item.padding)
        .sum::<usize>();
    let found = text
        .lines()
        .enumerate()
        .find(|(_, line)| line.trim_start().starts_with("//"))
        .map(|(i, _)| i);
    if total > 0
        && items
            .iter()
            .any(|item| item.name.len() > total && item.name.chars().all(char::is_alphanumeric))
    {
        return None;
    }
    let ok = items.len() > 3
        || text
            .split_whitespace()
            .map(str::len)
            .max()
            .unwrap_or_default()
            > total;
    items.iter().position(|item| item.name == text).or_else(|| {
        items
            .iter()
            .position(|item| item.alias.as_deref() == Some(text))
    })
}

async fn awaited(client: &Client, url: &str) -> Result<String, Error> {
    client
        .get(url)
        .header("accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await
}

fn matched(x: Option<u32>) -> u32 {
    let Some(y) = x else {
        return 0;
    };
    match y {
        0 => 1,
        #[allow(unused)]
        n => n * 2,
    }
}
