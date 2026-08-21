// Real MiniLM-L6-v2 sentence-embedding inference. Original source:
// Telegraph's own public MIT-licensed baseline scoring module
// (github.com/telegraphprotocol/telegraph-wasm-baseline), copyright (c)
// 2026 telegraphprotocol, MIT License. Carried over verbatim (engine code
// and weight/vocab binary assets, unchanged) from the sibling Telegraph
// Sentinel project's own adaptation (FRAUD_DETECTION intent), which proved
// this exact engine at Stage 2 (32/32 wins against its champion). The
// engine itself is domain-agnostic -- a generic English sentence encoder +
// WordPiece tokenizer, nothing FRAUD_DETECTION-specific -- so it ports
// directly to this project's ONCHAIN_TX_LOOKUP intent unchanged; only this
// project's own domain-specific scoring logic (status extraction,
// hallucination/role-swap detection, wei<->ETH equivalence) stays separate
// in lib.rs, exactly as Sentinel kept its own verdict/contradiction logic
// separate.

pub mod embed;
pub mod math;
pub mod mini_math;
pub mod tokenizer;
