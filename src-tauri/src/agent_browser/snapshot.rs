//! Turns `Accessibility.getFullAXTree` into the compact, ref-tagged text the
//! model reads: one line per element, interactive elements carrying `[eN]`.
//! This is the Comet design from the feature entry (section 0): the model
//! acts on refs, never on pixels or selectors, and the ref map this module
//! returns is the ONLY thing the guard accepts a click or a type against.
//!
//! What survives the tree: interactive roles get a ref and their state;
//! headings, text, list items and table cells are kept as plain lines;
//! generic wrappers are dropped with their children spliced up; inline text
//! boxes (duplicates of their StaticText parent) are dropped outright.
//! Consecutive text siblings merge into one line. Names and values are
//! truncated so one enormous attribute cannot dominate the budget.
//!
//! Size: the text is capped at `MAX_CHARS` (about 15k tokens). The runner
//! pages through anything past that with `read_more` rather than re-reading
//! the tree, so a long page costs one tree walk, not one per page.

use std::collections::HashMap;

use serde_json::Value;

/// About 15k tokens. The plan's snapshot budget (section 2 of the entry).
pub const MAX_CHARS: usize = 60_000;
const MAX_NAME_CHARS: usize = 120;
const MAX_TEXT_CHARS: usize = 200;
const MAX_DEPTH_INDENT: usize = 6;
/// Refs past this render as plain text: a page with more than this many
/// controls needs paging or scrolling, not a bigger prompt.
const MAX_REFS: usize = 600;

const INTERACTIVE: &[&str] = &[
    "link", "button", "textbox", "searchbox", "combobox", "listbox", "option",
    "checkbox", "radio", "switch", "slider", "spinbutton", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "menubutton",
];
/// Printed with their text; never given a ref.
const TEXTUAL: &[&str] = &[
    "StaticText", "heading", "paragraph", "listitem", "cell", "columnheader",
    "rowheader", "gridcell", "term", "definition", "time", "code", "blockquote",
    "caption", "LabelText", "Legend", "image", "img", "figure", "note", "tooltip",
    "alert", "status", "log", "marquee",
];
/// Printed only when named (a landmark or a labelled group).
const LANDMARK: &[&str] = &[
    "navigation", "main", "form", "dialog", "alertdialog", "search", "banner",
    "contentinfo", "complementary", "region", "article", "section", "group",
    "list", "table", "grid", "tree", "menu", "menubar", "tablist", "toolbar",
    "radiogroup", "row",
];
const DROPPED: &[&str] = &["InlineTextBox", "LineBreak", "none", "presentation", "ignored"];
const STATE_PROPS: &[&str] = &[
    "checked", "expanded", "disabled", "selected", "required", "focused",
    "pressed", "readonly", "invalid", "level", "multiselectable", "hasPopup",
];

#[derive(Clone)]
pub struct RefTarget {
    pub backend_node_id: i64,
    pub role: String,
    pub name: String,
}

pub struct Snapshot {
    /// The whole rendered tree, before paging.
    pub text: String,
    pub refs: HashMap<String, RefTarget>,
}

struct Node<'a> {
    role: &'a str,
    name: String,
    value: String,
    url: String,
    ignored: bool,
    backend: Option<i64>,
    children: Vec<&'a str>,
    props: Vec<String>,
}

fn string_at(value: &Value, path: &[&str]) -> String {
    let mut cursor = value;
    for key in path {
        match cursor.get(key) {
            Some(next) => cursor = next,
            None => return String::new(),
        }
    }
    match cursor {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        _ => String::new(),
    }
}

fn clean(text: &str, limit: usize) -> String {
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= limit {
        return collapsed;
    }
    let mut out: String = collapsed.chars().take(limit).collect();
    out.push_str("...");
    out
}

fn parse<'a>(raw: &'a [Value]) -> (HashMap<&'a str, Node<'a>>, Option<&'a str>) {
    let mut nodes = HashMap::with_capacity(raw.len());
    let mut root = None;
    for value in raw {
        let Some(id) = value.get("nodeId").and_then(Value::as_str) else { continue };
        let role = value
            .get("role")
            .and_then(|r| r.get("value"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut url = String::new();
        let mut props = Vec::new();
        if let Some(list) = value.get("properties").and_then(Value::as_array) {
            for prop in list {
                let name = prop.get("name").and_then(Value::as_str).unwrap_or("");
                let val = string_at(prop, &["value", "value"]);
                if name == "url" {
                    url = val;
                } else if STATE_PROPS.contains(&name) && !val.is_empty() && val != "false" {
                    props.push(if val == "true" { name.to_string() } else { format!("{name}={val}") });
                }
            }
        }
        let node = Node {
            role,
            name: clean(&string_at(value, &["name", "value"]), MAX_NAME_CHARS),
            value: clean(&string_at(value, &["value", "value"]), MAX_NAME_CHARS),
            url,
            ignored: value.get("ignored").and_then(Value::as_bool).unwrap_or(false),
            backend: value.get("backendDOMNodeId").and_then(Value::as_i64),
            children: value
                .get("childIds")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default(),
            props,
        };
        if root.is_none() && (value.get("parentId").is_none() || role == "RootWebArea") {
            root = Some(id);
        }
        nodes.insert(id, node);
    }
    (nodes, root)
}

struct Walker<'a> {
    nodes: &'a HashMap<&'a str, Node<'a>>,
    lines: Vec<String>,
    refs: HashMap<String, RefTarget>,
    next_ref: usize,
    pending_text: Vec<String>,
    pending_indent: usize,
}

impl<'a> Walker<'a> {
    fn flush_text(&mut self) {
        if self.pending_text.is_empty() {
            return;
        }
        let joined = clean(&self.pending_text.join(" "), MAX_TEXT_CHARS);
        let indent = "  ".repeat(self.pending_indent);
        self.lines.push(format!("{indent}{joined}"));
        self.pending_text.clear();
    }

    fn visit(&mut self, id: &str, depth: usize) {
        let Some(node) = self.nodes.get(id) else { return };
        let indent_level = depth.min(MAX_DEPTH_INDENT);
        let role = node.role;
        if node.ignored || DROPPED.contains(&role) || role == "generic" || role == "RootWebArea" {
            for child in &node.children {
                self.visit(child, depth);
            }
            return;
        }
        if role == "StaticText" {
            if !node.name.is_empty() {
                if self.pending_text.is_empty() {
                    self.pending_indent = indent_level;
                }
                self.pending_text.push(node.name.clone());
            }
            return;
        }
        self.flush_text();
        let indent = "  ".repeat(indent_level);
        if INTERACTIVE.contains(&role) {
            let mut line = String::new();
            let has_ref = self.refs.len() < MAX_REFS && node.backend.is_some();
            if has_ref {
                self.next_ref += 1;
                let key = format!("e{}", self.next_ref);
                line.push_str(&format!("[{key}] "));
                self.refs.insert(
                    key,
                    RefTarget {
                        backend_node_id: node.backend.unwrap_or_default(),
                        role: role.to_string(),
                        name: node.name.clone(),
                    },
                );
            }
            line.push_str(role);
            if !node.name.is_empty() {
                line.push_str(&format!(" \"{}\"", node.name));
            } else if role == "link" && !node.url.is_empty() {
                line.push_str(&format!(" -> {}", clean(&node.url, 80)));
            }
            if !node.value.is_empty() {
                line.push_str(&format!(" value=\"{}\"", node.value));
            }
            for prop in &node.props {
                line.push(' ');
                line.push_str(prop);
            }
            self.lines.push(format!("{indent}{line}"));
            for child in &node.children {
                self.visit(child, depth + 1);
            }
            self.flush_text();
            return;
        }
        if TEXTUAL.contains(&role) {
            let mut line = String::new();
            if role != "paragraph" && role != "listitem" && role != "cell" && role != "gridcell" {
                line.push_str(role);
                if !node.props.is_empty() {
                    line.push(' ');
                    line.push_str(&node.props.join(" "));
                }
                line.push_str(": ");
            }
            if !node.name.is_empty() {
                line.push_str(&node.name);
            }
            if line.trim_end_matches(": ").is_empty() {
                for child in &node.children {
                    self.visit(child, depth);
                }
                return;
            }
            self.lines.push(format!("{indent}{}", line.trim_end_matches(": ")));
            for child in &node.children {
                self.visit(child, depth + 1);
            }
            self.flush_text();
            return;
        }
        if LANDMARK.contains(&role) && !node.name.is_empty() {
            self.lines.push(format!("{indent}{role} \"{}\"", node.name));
            for child in &node.children {
                self.visit(child, depth + 1);
            }
            self.flush_text();
            return;
        }
        // Anything else is structure without content of its own.
        for child in &node.children {
            self.visit(child, depth);
        }
    }
}

/// Renders the tree. An empty tree (a page that has not painted an
/// accessibility tree yet) renders as a single line saying so.
pub fn render(raw: &[Value]) -> Snapshot {
    let (nodes, root) = parse(raw);
    let mut walker = Walker {
        nodes: &nodes,
        lines: Vec::new(),
        refs: HashMap::new(),
        next_ref: 0,
        pending_text: Vec::new(),
        pending_indent: 0,
    };
    if let Some(root) = root {
        walker.visit(root, 0);
        walker.flush_text();
    }
    if walker.lines.is_empty() {
        walker.lines.push("(the page has no accessible content yet)".to_string());
    }
    Snapshot {
        text: walker.lines.join("\n"),
        refs: walker.refs,
    }
}

/// One page of the rendered text, on a character boundary, plus whether
/// anything follows it.
pub fn page(text: &str, offset_chars: usize) -> (String, bool) {
    let total = text.chars().count();
    if offset_chars >= total {
        return (String::new(), false);
    }
    let chunk: String = text.chars().skip(offset_chars).take(MAX_CHARS).collect();
    (chunk, offset_chars + MAX_CHARS < total)
}
