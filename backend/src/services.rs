use std::path::PathBuf;
use std::env;
use std::fs::File;
use std::io::Read;
use video_rs::{Decoder, Location};
use gemini_rust::{Gemini, Model};
use tracing::{info, warn};
use base64::{engine::general_purpose, Engine as _};
use image::{ImageBuffer, Rgb};
use image::codecs::png::PngEncoder;
use image::ImageEncoder;
use serde::{Serialize, Deserialize};
use anyhow::Result;

// ==========================
// Public API (3 main funcs)
// ==========================

// Temporary compatibility wrapper for the existing handler.
// Returns JSON string of the processed records.
pub async fn get_frame() -> Result<String> {
    let records = process_video("data/video.mp4").await?;
    Ok(serde_json::to_string(&records)?)
}

/// Read an image from `frame_path`, base64-encode it, and send it to Gemini.
/// Returns the model's text response.
pub async fn send_to_llm(frame_path: PathBuf) -> Result<String> {
    // Read image file
    info!("Reading frame file: {:?}", frame_path);
    let mut file = File::open(frame_path)?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)?;
    let b64 = general_purpose::STANDARD.encode(&buffer);

    // Get API key
    // Model::Gemini25Flash - Default fast model
    // Model::Gemini25FlashLite - Lightweight model (now active in your code)
    // Model::Gemini25Pro - Advanced model with thinking capabilities
    // Model::TextEmbedding004 - For embeddings

    let api_key = env::var("GOOGLE_API_KEY")?;
    let client = Gemini::with_model(api_key, Model::Gemini25FlashLite)?;

    info!("Sending frame to Gemini");

    // Send image to Gemini with a prompt
    let response = client
        .generate_content()
        .with_user_message("Please describe what you see in this video frame.")
        .with_inline_data(b64, "image/png")
        .execute()
        .await?;

    let text = response.text();
    info!("Response received: {}", text);

    Ok(text)
}

// Record returned by `process_video` for each selected/sent frame.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FrameRecord {
    pub frame_id: u64,
    pub timestamp: f64,
    pub description: String,
    pub path: String, // using file path; can switch to base64 if you prefer
}

/// Summarize what happens in the video based on the per-frame descriptions.
/// Keeps it simple: sends a compact text transcript to Gemini and asks for
/// a short summary. No images are attached here to keep calls light.
pub async fn summarize_records(records: &[FrameRecord]) -> Result<String> {
    if records.is_empty() {
        return Ok("No frames processed; nothing to summarize.".to_string());
    }

    // Build a compact transcript
    let mut transcript = String::with_capacity(1024);
    transcript.push_str("Summarize the video in 2-3 sentences.\n\nFrames:\n");
    for r in records {
        // Keep to one line per frame
        use std::fmt::Write as _;
        let _ = writeln!(transcript, "- [{:.1}s] {}", r.timestamp, r.description);
    }

    let api_key = env::var("GOOGLE_API_KEY")?;
    let client = Gemini::with_model(api_key, Model::Gemini25FlashLite)?;

    let response = client
        .generate_content()
        .with_user_message(transcript)
        .execute()
        .await?;

    Ok(response.text())
}

/// Process a whole video at `video_path`:
/// - Send the first frame (ts=0.0) to the LLM and record it.
/// - Then consider the next two frames at ~0.5s and ~1.0s, and delegate to
///   `process_frame` which picks the more different one (by cosine similarity
///   vs the first frame), sends it to LLM, and returns a record.
/// - Currently processes only the first pair (0.5s and 1.0s) to keep things simple.
pub async fn process_video(video_path: impl Into<PathBuf>) -> Result<Vec<FrameRecord>> {
    video_rs::init().map_err(|_e| anyhow::anyhow!("video_rs init failed"))?;

    let file_path = video_path.into();
    let source = Location::File(file_path);
    let mut decoder = Decoder::new(&source)?;

    let (width, height) = decoder.size_out();
    let mut records: Vec<FrameRecord> = Vec::new();

    // 1) First frame -> save -> send to LLM
    let mut ref_img: Option<ImageBuffer<Rgb<u8>, Vec<u8>>> = None;
    let frame_id: u64 = 0;

    // pull first frame
    let mut iter = decoder.decode_iter();
    info!("Decoding first frame and sending to LLM...");
    while let Some(res) = iter.next() {
        if let Ok((_ts, frame)) = res {
            let data = frame.as_slice().ok_or_else(|| anyhow::anyhow!("Failed to get frame data"))?;
            let img: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_raw(width, height, data.to_vec())
                .ok_or_else(|| anyhow::anyhow!("Failed to create image buffer"))?;
            let path = save_png(&img, format!("data/frame_{:03}.png", frame_id))?;
            let description = send_to_llm(PathBuf::from(&path)).await?;
            records.push(FrameRecord { frame_id, timestamp: 0.0, description, path: path.clone() });
            ref_img = Some(img);
            info!("First frame processed; starting sampling at 0.5s");
            break;
        }
    }

    let ref_img = match ref_img { Some(img) => img, None => return Err(anyhow::anyhow!("No frame found")) };

    // 2) Collect samples every ~0.5s for sliding-window processing
    let mut next_sample = 0.5_f64; // seconds
    let mut samples: Vec<(u64, f64, ImageBuffer<Rgb<u8>, Vec<u8>>)> = Vec::new();
    let mut next_id = 1_u64; // aggregate frame id for samples; first was 0

    let mut frames_seen: u64 = 0;
    let mut last_ts: f64 = 0.0;
    for r in iter {
        match r {
            Ok((timestamp, frame)) => {
                let ts = timestamp.as_secs_f64();
                frames_seen += 1;
                last_ts = ts;
                if ts == 0.0 {
                    // Often means timestamp has no value and defaults to 0.0
                    // Not fatal, but sampling by time may never trigger.
                    // We'll just log it for now so we can diagnose.
                    if !timestamp.has_value() {
                        warn!("Frame {} has no PTS/DTS; as_secs_f64()=0.0", frames_seen);
                    }
                }
                // Log occasionally to avoid chatty logs
                if frames_seen % 30 == 0 {
                    info!("Decoded {} frames so far; last ts={:.3}", frames_seen, ts);
                }
                if ts + 1e-6 >= next_sample {
                    // Convert frame once
                let data = frame.as_slice().ok_or_else(|| anyhow::anyhow!("Failed to get frame data"))?;
                let img: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_raw(width, height, data.to_vec())
                    .ok_or_else(|| anyhow::anyhow!("Failed to create image buffer"))?;

                    // Satisfy all pending sample times up to this ts using the same image
                    while ts + 1e-6 >= next_sample {
                        samples.push((next_id, next_sample, img.clone()));
                        info!("Sampled id={} at ~{:.3}s (samples total: {})", next_id, next_sample, samples.len());
                        next_id += 1;
                        next_sample += 0.5;
                    }
                }
            }
            Err(e) => {
                info!("Decode iterator yielded error (likely EOF): {}. Exiting decode loop.", e);
                break;
            }
        }
    }

    info!(
        "Decode loop finished; frames_seen={}, last_ts={:.3}; samples_collected={}",
        frames_seen,
        last_ts,
        samples.len()
    );
    info!(
        "Sampling done: frames_seen={}, samples_collected={}, last_ts={:.3}",
        frames_seen,
        samples.len(),
        last_ts
    );

    // 3) Sliding window pairs over samples: [left, right] where left starts
    //    at the frame after the most recent LLM-sent frame
    let mut ref_img_cur = ref_img; // start with the first LLM-sent frame
    let mut left = 0usize; // samples[0] corresponds to 0.5s
    if samples.len() < 2 {
        info!("Not enough samples for comparisons ({}). Returning records.", samples.len());
        info!("Processing complete: {} records", records.len());
        return Ok(records);
    }
    let total_pairs = samples.len().saturating_sub(1);
    info!("Starting sliding-window comparisons: total_pairs={} starting_left={}", total_pairs, left);
    let mut processed_pairs = 0usize;
    while left + 1 < samples.len() {
        let pair = [
            (samples[left].0, samples[left].1, samples[left].2.clone()),
            (samples[left + 1].0, samples[left + 1].1, samples[left + 1].2.clone()),
        ];
        info!("Comparing pair: left=id{}@{:.3}s right=id{}@{:.3}s", samples[left].0, samples[left].1, samples[left+1].0, samples[left+1].1);
        let (rec, chosen_img) = process_frame(&ref_img_cur, pair).await?;
        info!("Chosen frame id={} at {:.3}s; appending record", rec.frame_id, rec.timestamp);
        records.push(rec);

        // Slide the window: left should be the index after the chosen
        // If chosen was left, move to (left+1, left+2). If right, move to (left+2, left+3)
        // Detect which one was chosen by matching frame_id
        let chosen_id = records.last().unwrap().frame_id;
        if chosen_id == samples[left].0 {
            left += 1;
        } else {
            left += 2;
        }

        // Update reference image to most recently LLM-sent
        ref_img_cur = chosen_img;
        processed_pairs += 1;
    }

    info!("Sliding-window comparisons complete: processed_pairs={}", processed_pairs);
    info!("Processing complete: {} records", records.len());
    println!("{}", serde_json::to_string_pretty(&records)?);
    Ok(records)
}

/// Compare two frames to the first reference frame via cosine similarity.
/// The more different one (lower cosine) is saved, sent to the LLM, and returned as a record.
pub async fn process_frame(
    ref_img: &ImageBuffer<Rgb<u8>, Vec<u8>>,
    pair: [(u64, f64, ImageBuffer<Rgb<u8>, Vec<u8>>); 2],
) -> Result<(FrameRecord, ImageBuffer<Rgb<u8>, Vec<u8>>)> {
    let (id_a, ts_a, img_a) = &pair[0];
    let (id_b, ts_b, img_b) = &pair[1];
    let cos_a = cosine_similarity(ref_img, img_a);
    let cos_b = cosine_similarity(ref_img, img_b);
    info!("Cosines vs ref: id{} -> {:.6}, id{} -> {:.6}", id_a, cos_a, id_b, cos_b);

    let (frame_id, ts, img) = if cos_a <= cos_b {
        (*id_a, *ts_a, img_a)
    } else {
        (*id_b, *ts_b, img_b)
    };

    // Save and send the selected frame
    let path = save_png(img, format!("data/frame_{:03}.png", frame_id))?;
    let description = send_to_llm(PathBuf::from(&path)).await?;

    Ok((FrameRecord { frame_id, timestamp: ts, description, path }, img.clone()))
}

// ==================
// Small helper funcs
// ==================

fn save_png(img: &ImageBuffer<Rgb<u8>, Vec<u8>>, path: String) -> Result<String> {
    let mut buf = Vec::new();
    let encoder = PngEncoder::new(&mut buf);
    encoder.write_image(img, img.width(), img.height(), image::ColorType::Rgb8.into())?;
    std::fs::write(&path, buf)?;
    info!("Saved frame to {}", path);
    Ok(path)
}

fn cosine_similarity(a: &ImageBuffer<Rgb<u8>, Vec<u8>>, b: &ImageBuffer<Rgb<u8>, Vec<u8>>) -> f64 {
    let ar = a.as_raw();
    let br = b.as_raw();
    if ar.len() != br.len() || ar.is_empty() { return 0.0; }
    let mut dot = 0.0_f64;
    let mut na = 0.0_f64;
    let mut nb = 0.0_f64;
    for (&x, &y) in ar.iter().zip(br.iter()) {
        let xf = x as f64; let yf = y as f64;
        dot += xf * yf; na += xf * xf; nb += yf * yf;
    }
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na.sqrt() * nb.sqrt()) }
}
