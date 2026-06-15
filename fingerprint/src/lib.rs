use base64::Engine;
use rusty_chromaprint::{Configuration, FingerprintCompressor, Fingerprinter};
use wasm_bindgen::prelude::*;

/// AcoustID-compatible Chromaprint fingerprint (compressed, URL-safe base64, no pad)
/// of interleaved i16 PCM. Returns null on too-short/failed input.
#[wasm_bindgen]
pub fn fingerprint(samples: &[i16], sample_rate: u32, channels: u32) -> Option<String> {
    let config = Configuration::preset_test2(); // AcoustID algorithm 2
    let mut printer = Fingerprinter::new(&config);
    printer.start(sample_rate, channels).ok()?;
    printer.consume(samples);
    printer.finish();
    let raw = printer.fingerprint();
    if raw.is_empty() {
        return None;
    }
    let compressed = FingerprintCompressor::from(&config).compress(raw);
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(compressed))
}
