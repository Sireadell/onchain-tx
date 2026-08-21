// Pure math utilities for MiniLM inference. All float ops use `libm`
// (pure-Rust software implementation) for deterministic, host-independent
// results. Adapted verbatim from Telegraph's public MIT-licensed baseline
// (github.com/telegraphprotocol/telegraph-wasm-baseline/src/math.rs).

/// Cosine similarity between two equal-length float32 slices, in [0, 1]
/// (negative similarity clamped to 0 -- "no match", not "anti-match").
#[inline]
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0f32;
    let mut norm_a = 0f32;
    let mut norm_b = 0f32;
    for (&ai, &bi) in a.iter().zip(b.iter()) {
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    let sim = dot / (crate::minilm::mini_math::sqrtf(norm_a) * crate::minilm::mini_math::sqrtf(norm_b));
    clamp01(sim)
}

#[inline]
pub fn clamp01(v: f32) -> f32 {
    if v < 0.0 {
        0.0
    } else if v > 1.0 {
        1.0
    } else {
        v
    }
}

#[inline]
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(&x, &y)| x * y).sum()
}

#[inline]
pub fn l2_norm(v: &[f32]) -> f32 {
    crate::minilm::mini_math::sqrtf(v.iter().map(|&x| x * x).sum::<f32>())
}

#[inline]
pub fn normalise(v: &mut [f32]) {
    let n = l2_norm(v);
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}
