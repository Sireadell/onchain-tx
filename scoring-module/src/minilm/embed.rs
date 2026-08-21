// MiniLM-L6-v2 embedding inference: real INT8-quantized encoder forward
// pass using weights embedded at compile time from
// weights/minilm_l6_v2_q8.bin. Adapted from Telegraph's public MIT-licensed
// baseline (github.com/telegraphprotocol/telegraph-wasm-baseline/src/embed.rs),
// with only the real_weights code path kept.
//
// This is a from-scratch re-implementation of a BERT-style encoder, matching
// MiniLM-L6-v2's actual graph exactly (6 layers, hidden=384, heads=12,
// intermediate=1536, post-LayerNorm, GELU activation) -- pretrained weights
// only produce meaningful output through the exact architecture they were
// trained with.
//
// Output is L2-normalised, so cosine similarity == dot product.

extern crate alloc;

use crate::minilm::tokenizer::{Encoding, MAX_SEQ_LEN};
use alloc::vec::Vec;

pub const EMBED_DIM: usize = 384;

static WEIGHTS: &[u8] = include_bytes!("../../weights/minilm_l6_v2_q8.bin");

const LN_EPS: f32 = 1e-12;

/// Run MiniLM inference on `encoding`. Returns L2-normalised float32[384].
pub fn run(encoding: &Encoding) -> [f32; EMBED_DIM] {
    let w = WEIGHTS;
    let mut c = 0usize;

    assert_eq!(&w[c..c + 4], b"MLM2", "weights magic mismatch");
    c += 4;
    let num_layers = read_u32(w, &mut c) as usize; // 6
    let hidden_size = read_u32(w, &mut c) as usize; // 384
    let num_heads = read_u32(w, &mut c) as usize; // 12
    let intermediate_size = read_u32(w, &mut c) as usize; // 1536
    let vocab_size = read_u32(w, &mut c) as usize; // 30522
    let num_positions = read_u32(w, &mut c) as usize;

    assert_eq!(
        num_positions, MAX_SEQ_LEN,
        "weights.bin position table size doesn't match tokenizer::MAX_SEQ_LEN"
    );
    assert_eq!(hidden_size % num_heads, 0, "hidden_size must divide evenly by num_heads");
    let head_dim = hidden_size / num_heads;

    // The word embedding table has 30,522 rows but a real answer only ever
    // needs a few dozen of them -- dequantizing the whole table into a Vec
    // here (as the baseline's original code does) means allocating ~47MB
    // (30522 * 384 * 4 bytes) on every single embed() call just to read a
    // handful of rows out of it. With a real allocator that gets reclaimed
    // once dropped; with this module's bump-only internal allocator (see
    // lib.rs) it doesn't, so this was blowing straight through any
    // reasonable internal-heap budget. Read the table's scale + starting
    // byte offset only, and dequantize just the specific rows actually
    // needed, on demand.
    let word_scale = read_f32(w, &mut c);
    let word_table_start = c;
    c += vocab_size * hidden_size; // skip past the table, don't materialize it

    let pos_emb = read_qtable(w, &mut c, num_positions, hidden_size);
    let type_emb = read_qtable(w, &mut c, 1, hidden_size);

    let emb_ln_gamma = read_f32_vec(w, &mut c, hidden_size);
    let emb_ln_beta = read_f32_vec(w, &mut c, hidden_size);

    let real_len = encoding
        .attention_mask
        .iter()
        .take_while(|&&m| m == 1)
        .count()
        .max(1);
    let attention_mask = &encoding.attention_mask[..real_len];

    let mut hidden: Vec<Vec<f32>> = Vec::with_capacity(real_len);
    for i in 0..real_len {
        let id = encoding.input_ids[i] as usize % vocab_size;
        let mut row = alloc::vec![0f32; hidden_size];
        let w_row_bytes = &w[word_table_start + id * hidden_size..][..hidden_size];
        let p_row = &pos_emb[(i % num_positions) * hidden_size..][..hidden_size];
        let t_row = &type_emb[0..hidden_size];
        for d in 0..hidden_size {
            let w_val = (w_row_bytes[d] as i8) as f32 * word_scale;
            row[d] = w_val + p_row[d] + t_row[d];
        }
        layer_norm(&mut row, &emb_ln_gamma, &emb_ln_beta);
        hidden.push(row);
    }

    for _ in 0..num_layers {
        hidden = transformer_layer(
            w,
            &mut c,
            &hidden,
            attention_mask,
            num_heads,
            head_dim,
            hidden_size,
            intermediate_size,
        );
    }

    let pooled = mean_pool(&hidden, attention_mask);

    let mut out = [0f32; EMBED_DIM];
    out.copy_from_slice(&pooled[..EMBED_DIM]);
    crate::minilm::math::normalise(&mut out);
    out
}

fn read_u32(w: &[u8], c: &mut usize) -> u32 {
    let v = u32::from_le_bytes(w[*c..*c + 4].try_into().unwrap());
    *c += 4;
    v
}

fn read_f32(w: &[u8], c: &mut usize) -> f32 {
    let v = f32::from_le_bytes(w[*c..*c + 4].try_into().unwrap());
    *c += 4;
    v
}

fn read_f32_vec(w: &[u8], c: &mut usize, n: usize) -> Vec<f32> {
    (0..n).map(|_| read_f32(w, c)).collect()
}

fn read_qtable(w: &[u8], c: &mut usize, rows: usize, cols: usize) -> Vec<f32> {
    let scale = read_f32(w, c);
    let n = rows * cols;
    let mat: Vec<f32> = w[*c..*c + n].iter().map(|&b| (b as i8) as f32 * scale).collect();
    *c += n;
    mat
}

fn read_linear(w: &[u8], c: &mut usize, in_dim: usize, out_dim: usize) -> Vec<f32> {
    read_qtable(w, c, out_dim, in_dim)
}

#[allow(clippy::too_many_arguments)]
fn transformer_layer(
    w: &[u8],
    c: &mut usize,
    hidden: &[Vec<f32>],
    attention_mask: &[u32],
    num_heads: usize,
    head_dim: usize,
    hidden_size: usize,
    intermediate_size: usize,
) -> Vec<Vec<f32>> {
    let seq_len = hidden.len();

    let q_w = read_linear(w, c, hidden_size, hidden_size);
    let q_b = read_f32_vec(w, c, hidden_size);
    let k_w = read_linear(w, c, hidden_size, hidden_size);
    let k_b = read_f32_vec(w, c, hidden_size);
    let v_w = read_linear(w, c, hidden_size, hidden_size);
    let v_b = read_f32_vec(w, c, hidden_size);
    let out_w = read_linear(w, c, hidden_size, hidden_size);
    let out_b = read_f32_vec(w, c, hidden_size);
    let attn_ln_gamma = read_f32_vec(w, c, hidden_size);
    let attn_ln_beta = read_f32_vec(w, c, hidden_size);
    let ffn1_w = read_linear(w, c, hidden_size, intermediate_size);
    let ffn1_b = read_f32_vec(w, c, intermediate_size);
    let ffn2_w = read_linear(w, c, intermediate_size, hidden_size);
    let ffn2_b = read_f32_vec(w, c, hidden_size);
    let out_ln_gamma = read_f32_vec(w, c, hidden_size);
    let out_ln_beta = read_f32_vec(w, c, hidden_size);

    let q: Vec<Vec<f32>> = hidden.iter().map(|h| matmul_row_bias(h, &q_w, &q_b, hidden_size)).collect();
    let k: Vec<Vec<f32>> = hidden.iter().map(|h| matmul_row_bias(h, &k_w, &k_b, hidden_size)).collect();
    let v: Vec<Vec<f32>> = hidden.iter().map(|h| matmul_row_bias(h, &v_w, &v_b, hidden_size)).collect();

    let scale_f = crate::minilm::mini_math::sqrtf(head_dim as f32);

    let mut attn_out: Vec<Vec<f32>> = Vec::with_capacity(seq_len);
    for i in 0..seq_len {
        let mut context_i = alloc::vec![0f32; hidden_size];

        for h in 0..num_heads {
            let hs = h * head_dim;
            let he = hs + head_dim;
            let q_head = &q[i][hs..he];

            let mut scores: Vec<f32> = (0..seq_len)
                .map(|j| {
                    if attention_mask[j] == 0 {
                        f32::NEG_INFINITY
                    } else {
                        crate::minilm::math::dot(q_head, &k[j][hs..he]) / scale_f
                    }
                })
                .collect();
            softmax(&mut scores);

            for (j, &wj) in scores.iter().enumerate() {
                if wj == 0.0 {
                    continue;
                }
                let v_head = &v[j][hs..he];
                for (ci, &vi) in context_i[hs..he].iter_mut().zip(v_head.iter()) {
                    *ci += wj * vi;
                }
            }
        }

        attn_out.push(context_i);
    }

    let mut normed1: Vec<Vec<f32>> = Vec::with_capacity(seq_len);
    for i in 0..seq_len {
        let projected = matmul_row_bias(&attn_out[i], &out_w, &out_b, hidden_size);
        let mut row: Vec<f32> = projected
            .iter()
            .zip(hidden[i].iter())
            .map(|(&a, &b)| a + b)
            .collect();
        layer_norm(&mut row, &attn_ln_gamma, &attn_ln_beta);
        normed1.push(row);
    }

    let mut out: Vec<Vec<f32>> = Vec::with_capacity(seq_len);
    for i in 0..seq_len {
        let mid: Vec<f32> = matmul_row_bias(&normed1[i], &ffn1_w, &ffn1_b, intermediate_size)
            .iter()
            .map(|&x| gelu(x))
            .collect();
        let delta = matmul_row_bias(&mid, &ffn2_w, &ffn2_b, hidden_size);
        let mut row: Vec<f32> = delta
            .iter()
            .zip(normed1[i].iter())
            .map(|(&a, &b)| a + b)
            .collect();
        layer_norm(&mut row, &out_ln_gamma, &out_ln_beta);
        out.push(row);
    }

    out
}

fn matmul_row_bias(input: &[f32], weights: &[f32], bias: &[f32], out_dim: usize) -> Vec<f32> {
    let in_dim = input.len();
    (0..out_dim)
        .map(|o| crate::minilm::math::dot(input, &weights[o * in_dim..(o + 1) * in_dim]) + bias[o])
        .collect()
}

fn layer_norm(row: &mut [f32], gamma: &[f32], beta: &[f32]) {
    let n = row.len() as f32;
    let mean: f32 = row.iter().sum::<f32>() / n;
    let var: f32 = row.iter().map(|&x| (x - mean) * (x - mean)).sum::<f32>() / n;
    let inv_std = 1.0 / crate::minilm::mini_math::sqrtf(var + LN_EPS);
    for (i, x) in row.iter_mut().enumerate() {
        *x = (*x - mean) * inv_std * gamma[i] + beta[i];
    }
}

fn mean_pool(hidden: &[Vec<f32>], mask: &[u32]) -> Vec<f32> {
    let dim = hidden[0].len();
    let mut sum = alloc::vec![0f32; dim];
    let mut count = 0f32;
    for (h, &m) in hidden.iter().zip(mask.iter()) {
        if m == 1 {
            for (s, &v) in sum.iter_mut().zip(h.iter()) {
                *s += v;
            }
            count += 1.0;
        }
    }
    if count > 0.0 {
        sum.iter_mut().for_each(|s| *s /= count);
    }
    sum
}

fn softmax(v: &mut [f32]) {
    let max = v.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let mut sum = 0f32;
    for x in v.iter_mut() {
        *x = if x.is_finite() || max.is_finite() {
            crate::minilm::mini_math::expf(*x - max)
        } else {
            0.0
        };
        sum += *x;
    }
    if sum > 0.0 {
        v.iter_mut().for_each(|x| *x /= sum);
    }
}

fn gelu(x: f32) -> f32 {
    const C: f32 = 0.797_884_6; // sqrt(2/pi)
    0.5 * x * (1.0 + crate::minilm::mini_math::tanhf(C * (x + 0.044_715 * x * x * x)))
}
