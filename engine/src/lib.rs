#![allow(clippy::missing_safety_doc)]
//! htl engine core — the single DSP spine.
//!
//! Compiled to `wasm32-unknown-unknown` it runs inside a desktop AudioWorklet
//! (Chromium); compiled to `aarch64` it runs inside a native audio render
//! callback (Oboe/AAudio on Android, CoreAudio on iOS). Same code, two host
//! shims — that's how desktop and mobile stay 1:1.
//!
//! The core only ever touches PCM. Stem separation and any neural "sound model"
//! run OFF this thread (a Worker / native NPU / the R2 cache) and hand their
//! output in as buffers — so the realtime guarantee holds no matter how heavy the
//! model is. A plain track is just one stem; a separated track is K stems sharing
//! ONE playhead, mixed per-stem-gain in `process()` (instant acapella / drop-the-
//! drums / stem EQ). The mix is the allocation-free hot path.

use core::slice;

/// Web render quantum is 128 frames; headroom for native hosts asking for more.
const MAX_BLOCK: usize = 1024;
/// Plenty for 4-stem (vocals/drums/bass/other), with room to spare.
const MAX_STEMS: usize = 8;

struct Stem {
    l: Vec<f32>,
    r: Vec<f32>, // == l for mono so reads are always stereo
    gain: f32,
}

pub struct Engine {
    sample_rate: f32,
    stems: Vec<Stem>,
    len: usize,    // frames (all stems are the same length — they're time-aligned)
    playhead: f64, // fractional sample index — the core's authoritative clock
    rate: f64,     // playback rate (1.0 = unity)
    playing: bool,
    out: Vec<f32>, // planar scratch [ L(0..n) , R(0..n) ] handed back to the host
}

/// Linear interpolation read of one channel buffer. The real core will reuse the
/// scratch worklet's 4-point cubic; linear is enough to prove the spine.
#[inline]
fn read(buf: &[f32], len: usize, pos: f64) -> f32 {
    let i = pos as usize;
    if i >= len {
        return 0.0;
    }
    if i + 1 >= len {
        return buf[i]; // final sample: no partner to interpolate against
    }
    let f = (pos - i as f64) as f32;
    buf[i] * (1.0 - f) + buf[i + 1] * f
}

impl Engine {
    fn new(sample_rate: f32) -> Self {
        Engine {
            sample_rate,
            stems: Vec::new(),
            len: 0,
            playhead: 0.0,
            rate: 1.0,
            playing: false,
            out: vec![0.0; MAX_BLOCK * 2],
        }
    }

    fn process(&mut self, n: usize) {
        let n = n.min(MAX_BLOCK);
        let end = self.len as f64; // emit every frame incl. the last, then stop
        let len = self.len;
        for i in 0..n {
            let (mut l, mut r) = (0.0f32, 0.0f32);
            if self.playing && self.playhead < end {
                let p = self.playhead;
                for s in &self.stems {
                    l += read(&s.l, len, p) * s.gain;
                    r += read(&s.r, len, p) * s.gain;
                }
                self.playhead += self.rate;
            } else {
                self.playing = false;
            }
            self.out[i] = l;
            self.out[n + i] = r;
        }
    }
}

// ---- C ABI: identical surface for the worklet glue and the native shim -------

#[no_mangle]
pub extern "C" fn engine_new(sample_rate: f32) -> *mut Engine {
    Box::into_raw(Box::new(Engine::new(sample_rate)))
}

#[no_mangle]
pub unsafe extern "C" fn engine_drop(e: *mut Engine) {
    if !e.is_null() {
        drop(Box::from_raw(e));
    }
}

/// Allocate a host-fillable f32 buffer inside wasm linear memory. The host writes
/// PCM here, then calls a load fn, then frees with `engine_free_buf`.
#[no_mangle]
pub extern "C" fn engine_alloc(n: usize) -> *mut f32 {
    let mut v = vec![0.0f32; n];
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn engine_free_buf(ptr: *mut f32, n: usize) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, n, n));
    }
}

/// Begin loading a (possibly stem-separated) track: declare how many stems and
/// the shared frame length, reset the playhead. Each stem is then filled with
/// `engine_load_stem`. `count == 1` is a plain track.
#[no_mangle]
pub unsafe extern "C" fn engine_stems_begin(e: *mut Engine, count: usize, frames: usize) {
    let e = &mut *e;
    let count = count.clamp(1, MAX_STEMS);
    e.len = frames;
    e.playhead = 0.0;
    e.stems = (0..count)
        .map(|_| Stem { l: Vec::new(), r: Vec::new(), gain: 1.0 })
        .collect();
}

/// Fill stem `idx`. `r` may be null for mono (duplicated so reads stay stereo).
#[no_mangle]
pub unsafe extern "C" fn engine_load_stem(
    e: *mut Engine,
    idx: usize,
    l: *const f32,
    r: *const f32,
    frames: usize,
    ch: usize,
) {
    let e = &mut *e;
    if idx >= e.stems.len() {
        return;
    }
    let lv = slice::from_raw_parts(l, frames).to_vec();
    let rv = if ch >= 2 && !r.is_null() {
        slice::from_raw_parts(r, frames).to_vec()
    } else {
        lv.clone()
    };
    e.stems[idx].l = lv;
    e.stems[idx].r = rv;
}

/// Per-stem gain (0 = muted). This is the realtime acapella/instrumental knob.
#[no_mangle]
pub unsafe extern "C" fn engine_set_stem_gain(e: *mut Engine, idx: usize, gain: f32) {
    let e = &mut *e;
    if let Some(s) = e.stems.get_mut(idx) {
        s.gain = gain;
    }
}

/// Convenience: load a plain (single-stem) stereo track.
#[no_mangle]
pub unsafe extern "C" fn engine_load(e: *mut Engine, l: *const f32, r: *const f32, frames: usize, ch: usize) {
    engine_stems_begin(e, 1, frames);
    engine_load_stem(e, 0, l, r, frames, ch);
}

/// Control surface. id: 0=play(0/1) 1=rate 2=seek(seconds).
#[no_mangle]
pub unsafe extern "C" fn engine_set(e: *mut Engine, id: u32, v: f32) {
    let e = &mut *e;
    match id {
        0 => e.playing = v != 0.0,
        1 => e.rate = v as f64,
        2 => e.playhead = (v as f64) * e.sample_rate as f64,
        _ => {}
    }
}

/// Render `n` frames and return a pointer to the planar scratch
/// `[ L(0..n) , R(0..n) ]` for the host to copy into its output.
#[no_mangle]
pub unsafe extern "C" fn engine_process(e: *mut Engine, n: usize) -> *mut f32 {
    let e = &mut *e;
    e.process(n);
    e.out.as_mut_ptr()
}

/// Authoritative playhead in seconds — read into SAB (web) / shared mem (native)
/// so the visuals lock to the audio instead of guessing from context time.
#[no_mangle]
pub unsafe extern "C" fn engine_playhead(e: *mut Engine) -> f64 {
    let e = &*e;
    e.playhead / e.sample_rate as f64
}
