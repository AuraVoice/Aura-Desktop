//! Content-anchored relocation of a text span across edits.
//!
//! This is the module that makes "what did the user change about what Aura
//! typed" answerable. Pure text logic, no COM, no Windows: `anchor.rs` reads
//! the field, this decides where a previously recorded span moved to.
//!
//! THE RULE THIS EXISTS TO ENFORCE: time is never ground truth. "The user
//! typed something 20 seconds after dictating" says nothing about whether they
//! touched the dictated words. A span is only ever reported as edited when its
//! surrounding text is re-found in the field, which means every reported
//! correction is backed by the actual characters either side of it rather than
//! by a clock. When the surroundings cannot be re-found, the answer is `Lost`
//! and nothing is recorded - a missing observation is always better than an
//! invented one, because an invented one becomes a training label.
//!
//! Offsets are CHARACTER offsets into a `&[char]`, never byte offsets. The
//! field content is arbitrary user text; byte slicing it would panic on the
//! first multi-byte character that lands on a boundary, exactly the bug
//! `vocab::replace_phrase` already had to be fixed for.

/// How much text either side of a span is used to re-find it, longest first.
///
/// 48 characters is long enough to be distinctive in ordinary prose. The
/// shorter rungs exist because a user editing right up against the dictated
/// words wipes out the long context but usually leaves the short one intact,
/// and a short context resolved to the nearest occurrence beats giving up.
const CONTEXT_LADDER: [usize; 4] = [48, 24, 12, 6];

/// A relocated span may grow (the user expanded the sentence) but not without
/// limit: past this, the match is treated as having swallowed unrelated text
/// rather than as a very large edit. Absolute term covers short spans, where a
/// multiplier alone is far too tight.
const MAX_GROWTH_FACTOR: usize = 4;
const MAX_GROWTH_SLACK: usize = 96;

/// One span's position in the baseline text it was last observed against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn len(&self) -> usize {
        self.end.saturating_sub(self.start)
    }
}

/// Where a span ended up, and how confident that answer is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relocation {
    /// Both edges were re-found. `span` is the span's new extent, and the text
    /// inside it is what the user now has where Aura's words used to be.
    ///
    /// `exact` means the span's own characters were re-found unchanged
    /// alongside their context, so nothing inside it moved. It is a confidence
    /// signal for logging and for ranking observations, not a correctness
    /// gate: an `exact: false` relocation is still a verified one, it just
    /// found the edges rather than the whole neighbourhood.
    Located { span: Span, exact: bool },
    /// The edges were re-found immediately adjacent to each other: everything
    /// Aura typed there is gone. Not a correction - the user threw it away.
    Removed { at: usize },
    /// The surroundings could not be re-found. Nothing is recorded.
    Lost,
}

/// Finds where `span` (expressed in `baseline` coordinates) now sits in
/// `current`.
///
/// The search is anchored on the text either side of the span rather than on
/// the span's own content, because the span's content is precisely what is
/// expected to have changed. Candidates are ranked by distance from where the
/// span used to be, so a phrase that occurs many times in a long document
/// resolves to the nearest occurrence instead of the first one in the file.
pub fn relocate(baseline: &[char], span: Span, current: &[char]) -> Relocation {
    if span.start > span.end || span.end > baseline.len() {
        return Relocation::Lost;
    }
    // Nothing changed at all. Overwhelmingly the common case on the early
    // observations, and worth not paying a search for.
    if baseline == current {
        return Relocation::Located { span, exact: true };
    }

    // Pass 1: the whole neighbourhood is intact somewhere. This is the only
    // answer that can be called exact, because left + body + right matching
    // means no character of the span itself moved relative to its context.
    for context in CONTEXT_LADDER {
        let left = slice_left(baseline, span.start, context);
        let right = slice_right(baseline, span.end, context);
        let body = &baseline[span.start..span.end];
        let mut needle = Vec::with_capacity(left.len() + body.len() + right.len());
        needle.extend_from_slice(left);
        needle.extend_from_slice(body);
        needle.extend_from_slice(right);
        if needle.is_empty() {
            break;
        }
        if let Some(at) = find_nearest(current, &needle, span.start.saturating_sub(left.len())) {
            let start = at + left.len();
            return Relocation::Located {
                span: Span {
                    start,
                    end: start + body.len(),
                },
                exact: true,
            };
        }
    }

    // Pass 2: the edges are intact but the middle changed, which is the case
    // this whole module exists for. Each ladder rung is tried in full before
    // dropping to a shorter, less distinctive context.
    for context in CONTEXT_LADDER {
        let left = slice_left(baseline, span.start, context);
        let right = slice_right(baseline, span.end, context);
        if let Some(relocation) = locate_between(span, current, left, right) {
            return relocation;
        }
    }

    Relocation::Lost
}

/// One ladder rung: find the left context, then the right context after it,
/// and take everything between them as the span's new extent.
fn locate_between(
    span: Span,
    current: &[char],
    left: &[char],
    right: &[char],
) -> Option<Relocation> {
    // A span at the very start of the field has no left context, and one at
    // the very end has no right context. Both are ordinary - a dictation into
    // an empty box is the single most common case there is - so an absent edge
    // anchors to the corresponding end of the field instead of failing.
    let left_end = if left.is_empty() {
        0
    } else {
        let at = find_nearest(current, left, span.start.saturating_sub(left.len()))?;
        at + left.len()
    };

    let right_start = if right.is_empty() {
        current.len()
    } else {
        // Searched only at or after the left edge: a right context found
        // BEFORE the left one describes a different occurrence entirely.
        let from = left_end;
        let expected = span.end.max(from);
        find_nearest_from(current, right, expected, from)?
    };

    if right_start < left_end {
        return None;
    }
    let grown = right_start - left_end;
    if grown > span.len() * MAX_GROWTH_FACTOR + MAX_GROWTH_SLACK {
        // The right context was re-found, but so far away that the "span" would
        // now include text the user wrote about something else. Refusing here
        // is what stops one stale anchor from claiming half a document.
        return None;
    }
    // A field the user cleared entirely re-finds nothing at all, so it lands in
    // `Lost` rather than here; `Removed` is specifically the case where the
    // surrounding text survived and only the dictated words were deleted.
    if grown == 0 && span.len() > 0 {
        return Some(Relocation::Removed { at: left_end });
    }
    // Never exact: pass 1 above is the only path that re-finds the span's own
    // characters, so reaching here means the middle is free to have changed.
    Some(Relocation::Located {
        span: Span {
            start: left_end,
            end: right_start,
        },
        exact: false,
    })
}

fn slice_left(text: &[char], at: usize, context: usize) -> &[char] {
    let at = at.min(text.len());
    &text[at.saturating_sub(context)..at]
}

fn slice_right(text: &[char], at: usize, context: usize) -> &[char] {
    let at = at.min(text.len());
    &text[at..(at + context).min(text.len())]
}

/// All occurrences of `needle`, resolved to the one starting nearest to
/// `expected`. Ties break towards the earlier occurrence.
fn find_nearest(haystack: &[char], needle: &[char], expected: usize) -> Option<usize> {
    find_nearest_from(haystack, needle, expected, 0)
}

fn find_nearest_from(
    haystack: &[char],
    needle: &[char],
    expected: usize,
    from: usize,
) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() || needle.len() > haystack.len() - from {
        return None;
    }
    let mut best: Option<(usize, usize)> = None;
    for start in from..=(haystack.len() - needle.len()) {
        if &haystack[start..start + needle.len()] != needle {
            continue;
        }
        let distance = start.abs_diff(expected);
        match best {
            Some((_, best_distance)) if best_distance <= distance => {}
            _ => best = Some((start, distance)),
        }
        // Distance can only grow once the scan passes `expected`, so the first
        // match at or after it is the last candidate worth considering.
        if start >= expected {
            break;
        }
    }
    best.map(|(start, _)| start)
}

/// Keeps a set of relocated spans from overlapping.
///
/// Two dictations into the same field are two independent records, and each is
/// relocated on its own. A very permissive match on the older one can extend it
/// over the newer one's text, which would then report the newer dictation as
/// an "edit" to the older. Clipping each span at the next one's start makes
/// that structurally impossible.
///
/// `spans` is sorted in place by start offset; the caller keeps its own
/// identifiers alongside, hence the index-carrying tuple.
pub fn clip_overlaps(spans: &mut [(usize, Span)]) {
    spans.sort_by_key(|(_, span)| (span.start, span.end));
    for index in 1..spans.len() {
        let next_start = spans[index].1.start;
        let previous = &mut spans[index - 1].1;
        if previous.end > next_start {
            previous.end = next_start.max(previous.start);
        }
    }
}

/// Where a freshly typed string landed in the field, given what the field held
/// immediately before the keystrokes.
///
/// This is the one measurement that is verified rather than inferred: `before`
/// is read on the same UI Automation round trip that clears dictation to type,
/// `after` is read once the keystrokes are in, and the span is accepted only
/// when the two differ by exactly the inserted text. An application that
/// autocorrects, autocompletes or reformats what was typed fails that check and
/// reports `None`, so its transformed text never becomes a training label
/// attributed to Aura's recognizer.
pub fn locate_insertion(before: &[char], after: &[char], inserted: &[char]) -> Option<Span> {
    if inserted.is_empty() || after.len() != before.len() + inserted.len() {
        return None;
    }
    let prefix = common_prefix(before, after);
    let suffix = common_suffix(&before[prefix..], &after[prefix..]);
    // Everything that is not shared prefix or shared suffix must be exactly the
    // inserted text, and it must sit at one contiguous position.
    let start = prefix;
    let end = after.len() - suffix;
    if end < start || &after[start..end] != inserted {
        return None;
    }
    Some(Span { start, end })
}

fn common_prefix(left: &[char], right: &[char]) -> usize {
    left.iter()
        .zip(right.iter())
        .take_while(|(a, b)| a == b)
        .count()
}

fn common_suffix(left: &[char], right: &[char]) -> usize {
    left.iter()
        .rev()
        .zip(right.iter().rev())
        .take_while(|(a, b)| a == b)
        .count()
}
