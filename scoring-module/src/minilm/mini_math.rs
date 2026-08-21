// Minimal pure-Rust sqrt/exp/tanh, standing in for the `libm` crate.
//
// Not using `libm` because Cargo build scripts (including libm's own, and
// any crate's) always compile+link a small executable for the HOST
// platform first, regardless of the actual wasm32-unknown-unknown build
// target -- and this machine has no working MSVC linker (confirmed:
// Microsoft Visual Studio/Build Tools aren't installed at all). Installing
// a multi-GB compiler toolchain just to get a math library felt like the
// wrong tradeoff versus writing three small functions, especially since
// this project has been dependency-free until this feature.
//
// These don't need to be bit-exact with any reference implementation --
// only internally consistent, since nothing outside this module ever reads
// raw exp()/tanh() output directly; they only feed into softmax (which
// normalises its own output by dividing by the row sum, so a small
// constant relative error partially cancels) and GELU (a smooth activation
// where a small error is imperceptible against int8-quantized weights that
// already carry more error than that).

/// sqrt via a bit-trick initial guess plus Newton-Raphson refinement.
/// Accurate to within a few ULPs for positive, finite, non-tiny inputs --
/// plenty for L2-normalisation and attention scaling here.
pub fn sqrtf(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let i = x.to_bits();
    let guess_bits = 0x1fbd1df5 + (i >> 1);
    let mut y = f32::from_bits(guess_bits);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y
}

/// exp(x) via Schraudolph's fast bit-manipulation approximation: exp(x) =
/// 2^(x * log2(e)), computed by writing x*log2(e) directly into an f32's
/// exponent/mantissa bits. A few percent relative error, which is fine
/// here (see module doc) -- this is not being used anywhere that needs
/// precise log-likelihoods.
pub fn expf(x: f32) -> f32 {
    if x < -87.0 {
        return 0.0; // underflow guard, matches roughly where f32 exp hits subnormal/zero
    }
    if x > 88.0 {
        return f32::MAX; // overflow guard -- softmax always feeds x <= 0 in practice anyway
    }
    const A: f32 = 12_102_203.0; // 2^23 / ln(2)
    const B: i32 = 1_064_866_805; // bias term for the f32 bit layout
    let y = (A * x) as i32 + B;
    f32::from_bits(y as u32)
}

/// tanh(x) = 2*sigmoid(2x) - 1, built from expf above. Clamped for large
/// |x| both to avoid overflow in the intermediate exp and because tanh is
/// already saturated to +/-1 well before |x| = 10.
pub fn tanhf(x: f32) -> f32 {
    if x > 10.0 {
        return 1.0;
    }
    if x < -10.0 {
        return -1.0;
    }
    let e2x = expf(2.0 * x);
    (e2x - 1.0) / (e2x + 1.0)
}
