use image::RgbaImage;

pub const WIDTH: usize = 64;
pub const HEIGHT: usize = 36;
pub const TILE_COLS: usize = 6;
pub const TILE_ROWS: usize = 4;
pub const TILE_COUNT: usize = TILE_COLS * TILE_ROWS;

const PIXEL_COUNT: usize = WIDTH * HEIGHT;
const MOTION_LUMA_THRESHOLD: f32 = 5.5;
const MOTION_CHROMA_THRESHOLD: f32 = 4.0;
const MOTION_EDGE_THRESHOLD: f32 = 9.0;
const CHANGE_LUMA_THRESHOLD: f32 = 6.5;
const CHANGE_CHROMA_THRESHOLD: f32 = 4.5;
const CHANGE_EDGE_THRESHOLD: f32 = 10.0;
const ENTER_TRANSIENT_AFTER: u8 = 2;
const LEAVE_TRANSIENT_AFTER: u8 = 2;

#[derive(Clone, Debug, PartialEq)]
pub struct Fingerprint {
    y: Vec<u8>,
    cb: Vec<u8>,
    cr: Vec<u8>,
    edge: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TileDiff {
    pub luma: f32,
    pub chroma: f32,
    pub edge: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Same,
    Hold,
    ChangedStable,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Classification {
    pub verdict: Verdict,
    pub changed_tiles: usize,
    pub transient_tiles: usize,
    pub dist_vs_committed: f32,
}

#[derive(Clone, Debug, Default)]
pub struct Detector {
    moving_streak: [u8; TILE_COUNT],
    still_streak: [u8; TILE_COUNT],
    transient: [bool; TILE_COUNT],
}

impl Fingerprint {
    pub fn from_rgba(image: &RgbaImage) -> Self {
        let source_width = image.width().max(1) as usize;
        let source_height = image.height().max(1) as usize;
        let mut y_plane = Vec::with_capacity(PIXEL_COUNT);
        let mut cb_plane = Vec::with_capacity(PIXEL_COUNT);
        let mut cr_plane = Vec::with_capacity(PIXEL_COUNT);

        for y in 0..HEIGHT {
            let source_y = (y * source_height / HEIGHT).min(source_height - 1) as u32;
            for x in 0..WIDTH {
                let source_x = (x * source_width / WIDTH).min(source_width - 1) as u32;
                let pixel = image.get_pixel(source_x, source_y).0;
                let red = pixel[0] as f32;
                let green = pixel[1] as f32;
                let blue = pixel[2] as f32;
                y_plane.push((0.299 * red + 0.587 * green + 0.114 * blue).round() as u8);
                cb_plane
                    .push((128.0 - 0.168_736 * red - 0.331_264 * green + 0.5 * blue).round() as u8);
                cr_plane
                    .push((128.0 + 0.5 * red - 0.418_688 * green - 0.081_312 * blue).round() as u8);
            }
        }

        let mut edge = vec![0; PIXEL_COUNT];
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let index = y * WIDTH + x;
                let right = y * WIDTH + (x + 1).min(WIDTH - 1);
                let down = (y + 1).min(HEIGHT - 1) * WIDTH + x;
                edge[index] = y_plane[index]
                    .abs_diff(y_plane[right])
                    .saturating_add(y_plane[index].abs_diff(y_plane[down]));
            }
        }

        Self {
            y: y_plane,
            cb: cb_plane,
            cr: cr_plane,
            edge,
        }
    }

    pub fn is_blank(&self) -> bool {
        let mean =
            self.y.iter().map(|value| *value as u64).sum::<u64>() as f32 / PIXEL_COUNT as f32;
        let spread = self
            .y
            .iter()
            .map(|value| (*value as f32 - mean).abs())
            .sum::<f32>()
            / PIXEL_COUNT as f32;
        mean < 4.0 && spread < 1.5
    }

    #[cfg(test)]
    fn solid(value: u8) -> Self {
        let mut image = RgbaImage::new(WIDTH as u32, HEIGHT as u32);
        for pixel in image.pixels_mut() {
            *pixel = image::Rgba([value, value, value, 255]);
        }
        Self::from_rgba(&image)
    }

    #[cfg(test)]
    fn with_tile(mut self, tile: usize, value: u8) -> Self {
        let (x_start, x_end, y_start, y_end) = tile_bounds(tile);
        for y in y_start..y_end {
            for x in x_start..x_end {
                let index = y * WIDTH + x;
                self.y[index] = value;
            }
        }
        self.rebuild_edges();
        self
    }

    #[cfg(test)]
    fn rebuild_edges(&mut self) {
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let index = y * WIDTH + x;
                let right = y * WIDTH + (x + 1).min(WIDTH - 1);
                let down = (y + 1).min(HEIGHT - 1) * WIDTH + x;
                self.edge[index] = self.y[index]
                    .abs_diff(self.y[right])
                    .saturating_add(self.y[index].abs_diff(self.y[down]));
            }
        }
    }
}

impl Detector {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn classify(
        &mut self,
        previous: &Fingerprint,
        current: &Fingerprint,
        committed: Option<&Fingerprint>,
    ) -> Classification {
        let mut changed_tiles = 0;
        let mut moving_non_transient = 0;
        let mut reintegrated = [false; TILE_COUNT];
        let mut total_committed_distance = 0.0;

        for tile in 0..TILE_COUNT {
            let motion = tile_diff(previous, current, tile);
            let moving = is_motion(motion);
            if moving {
                self.moving_streak[tile] = self.moving_streak[tile].saturating_add(1);
                self.still_streak[tile] = 0;
                if self.moving_streak[tile] >= ENTER_TRANSIENT_AFTER {
                    self.transient[tile] = true;
                }
            } else {
                self.moving_streak[tile] = 0;
                self.still_streak[tile] = self.still_streak[tile].saturating_add(1);
                if self.transient[tile] && self.still_streak[tile] >= LEAVE_TRANSIENT_AFTER {
                    self.transient[tile] = false;
                    reintegrated[tile] = true;
                }
            }

            if moving && !self.transient[tile] {
                moving_non_transient += 1;
            }

            if let Some(committed) = committed {
                let distance = tile_diff(committed, current, tile);
                total_committed_distance += combined_distance(distance);
                if (!self.transient[tile] || reintegrated[tile]) && is_change(distance) {
                    changed_tiles += 1;
                }
            }
        }

        let stable = moving_non_transient == 0;
        if committed.is_none() && stable {
            changed_tiles = 1;
        }
        let verdict = if changed_tiles == 0 {
            Verdict::Same
        } else if stable {
            Verdict::ChangedStable
        } else {
            Verdict::Hold
        };

        Classification {
            verdict,
            changed_tiles,
            transient_tiles: self.transient.iter().filter(|value| **value).count(),
            dist_vs_committed: total_committed_distance / TILE_COUNT as f32,
        }
    }
}

fn tile_diff(left: &Fingerprint, right: &Fingerprint, tile: usize) -> TileDiff {
    let (x_start, x_end, y_start, y_end) = tile_bounds(tile);
    let mut y_sum = 0_u64;
    let mut chroma_sum = 0_u64;
    let mut edge_sum = 0_u64;
    let mut count = 0_u64;
    for y in y_start..y_end {
        for x in x_start..x_end {
            let index = y * WIDTH + x;
            y_sum += left.y[index].abs_diff(right.y[index]) as u64;
            chroma_sum += left.cb[index].abs_diff(right.cb[index]) as u64;
            chroma_sum += left.cr[index].abs_diff(right.cr[index]) as u64;
            edge_sum += left.edge[index].abs_diff(right.edge[index]) as u64;
            count += 1;
        }
    }
    TileDiff {
        luma: y_sum as f32 / count as f32,
        chroma: chroma_sum as f32 / (count * 2) as f32,
        edge: edge_sum as f32 / count as f32,
    }
}

fn tile_bounds(tile: usize) -> (usize, usize, usize, usize) {
    let column = tile % TILE_COLS;
    let row = tile / TILE_COLS;
    (
        column * WIDTH / TILE_COLS,
        (column + 1) * WIDTH / TILE_COLS,
        row * HEIGHT / TILE_ROWS,
        (row + 1) * HEIGHT / TILE_ROWS,
    )
}

fn is_motion(diff: TileDiff) -> bool {
    diff.luma >= MOTION_LUMA_THRESHOLD
        || diff.chroma >= MOTION_CHROMA_THRESHOLD
        || diff.edge >= MOTION_EDGE_THRESHOLD
}

fn is_change(diff: TileDiff) -> bool {
    diff.luma >= CHANGE_LUMA_THRESHOLD
        || diff.chroma >= CHANGE_CHROMA_THRESHOLD
        || diff.edge >= CHANGE_EDGE_THRESHOLD
}

fn combined_distance(diff: TileDiff) -> f32 {
    diff.luma + diff.chroma + diff.edge
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_low_motion_comparison_is_settled() {
        let previous = Fingerprint::solid(40);
        let current = Fingerprint::solid(40).with_tile(3, 90);
        let committed = Fingerprint::solid(40);
        let mut detector = Detector::default();

        let moving = detector.classify(&previous, &current, Some(&committed));
        assert_eq!(moving.verdict, Verdict::Hold);
        let settled = detector.classify(&current, &current, Some(&committed));
        assert_eq!(settled.verdict, Verdict::ChangedStable);
    }

    #[test]
    fn transient_tile_enters_leaves_and_reintegrates_final_state() {
        let committed = Fingerprint::solid(30);
        let frame_a = committed.clone().with_tile(8, 90);
        let frame_b = committed.clone().with_tile(8, 150);
        let final_frame = committed.clone().with_tile(8, 210);
        let mut detector = Detector::default();

        detector.classify(&committed, &frame_a, Some(&committed));
        let entered = detector.classify(&frame_a, &frame_b, Some(&committed));
        assert_eq!(entered.transient_tiles, 1);

        detector.classify(&frame_b, &final_frame, Some(&committed));
        let first_still = detector.classify(&final_frame, &final_frame, Some(&committed));
        assert_eq!(first_still.transient_tiles, 1);
        let left = detector.classify(&final_frame, &final_frame, Some(&committed));
        assert_eq!(left.transient_tiles, 0);
        assert_eq!(left.verdict, Verdict::ChangedStable);
        assert!(left.changed_tiles >= 1);
    }

    #[test]
    fn blank_detection_requires_dark_uniform_pixels() {
        assert!(Fingerprint::solid(0).is_blank());
        assert!(!Fingerprint::solid(30).is_blank());
        assert!(!Fingerprint::solid(0).with_tile(0, 255).is_blank());
    }
}
