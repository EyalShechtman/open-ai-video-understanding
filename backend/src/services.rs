use anyhow::{Context, Result};
use base64::{engine::general_purpose, Engine as _};
use gemini_rust::{Gemini, Model};
use image::codecs::png::PngEncoder;
use image::ImageEncoder;
use image::{ImageBuffer, Rgb};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::env;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{info, warn};
use video_rs::{Decoder, Location};

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
    // Get API key and preferred model
    let api_key = env::var("GOOGLE_API_KEY")?;
    let model_name = env::var("GEMINI_MODEL").ok();
    let model = resolve_model(model_name.as_deref());

    info!("Sending frame to Gemini");

    let text = describe_png_bytes(&api_key, model, buffer).await?;
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

type Sample = (u64, f64, ImageBuffer<Rgb<u8>, Vec<u8>>);

/// Runtime context for queuing frame-description jobs with bounded concurrency.
#[derive(Clone)]
struct FrameJobContext {
    api_key: Arc<String>,
    model: Model,
    semaphore: Arc<Semaphore>,
}

impl FrameJobContext {
    fn new(api_key: String, model: Model, max_concurrency: usize) -> Self {
        Self {
            api_key: Arc::new(api_key),
            model,
            semaphore: Arc::new(Semaphore::new(max_concurrency.max(1))),
        }
    }

    fn queue(
        &self,
        tasks: &mut JoinSet<Result<FrameRecord>>,
        frame_id: u64,
        timestamp: f64,
        image: ImageBuffer<Rgb<u8>, Vec<u8>>,
    ) {
        let ctx = self.clone();
        tasks.spawn(async move {
            let _permit = ctx
                .semaphore
                .acquire_owned()
                .await
                .context("failed to acquire concurrency permit")?;

            let png_bytes = tokio::task::spawn_blocking(move || encode_png(image))
                .await
                .context("PNG encode task panicked")??;

            let path = format!("data/frame_{:03}.png", frame_id);
            fs::write(&path, &png_bytes)
                .await
                .with_context(|| format!("failed to write frame image to {}", path))?;

            let description =
                describe_png_bytes(ctx.api_key.as_ref(), ctx.model, png_bytes).await?;

            Ok(FrameRecord {
                frame_id,
                timestamp,
                description,
                path,
            })
        });
    }
}

/// Result of selecting a sample from a candidate pair.
struct FrameSelection {
    frame_id: u64,
    timestamp: f64,
    image: ImageBuffer<Rgb<u8>, Vec<u8>>,
    chosen_left: bool,
}

fn load_llm_max_concurrency() -> usize {
    const DEFAULT: usize = 64;
    match env::var("LLM_MAX_CONCURRENCY") {
        Ok(raw) => match raw.parse::<usize>() {
            Ok(value) if value > 0 => value,
            _ => {
                warn!(
                    "Invalid LLM_MAX_CONCURRENCY value '{}'; using {}",
                    raw, DEFAULT
                );
                DEFAULT
            }
        },
        Err(_) => DEFAULT,
    }
}

fn resolve_model(model_name: Option<&str>) -> Model {
    match model_name {
        Some("Gemini25Flash") => Model::Gemini25Flash,
        Some("Gemini25Pro") => Model::Gemini25Pro,
        Some("TextEmbedding004") => Model::TextEmbedding004,
        Some("Gemini25FlashLite") | None => Model::Gemini25FlashLite,
        Some(other) => {
            warn!(
                "Unknown GEMINI_MODEL '{}'; defaulting to Gemini25FlashLite",
                other
            );
            Model::Gemini25FlashLite
        }
    }
}

fn encode_png(image: ImageBuffer<Rgb<u8>, Vec<u8>>) -> Result<Vec<u8>> {
    let width = image.width();
    let height = image.height();
    let raw = image.into_raw();
    let mut buf = Vec::new();
    let encoder = PngEncoder::new(&mut buf);
    encoder.write_image(&raw, width, height, image::ColorType::Rgb8.into())?;
    Ok(buf)
}

async fn describe_png_bytes(api_key: &str, model: Model, png_bytes: Vec<u8>) -> Result<String> {
    let b64 = tokio::task::spawn_blocking(move || general_purpose::STANDARD.encode(png_bytes))
        .await
        .context("base64 encode task panicked")?;

    let client = Gemini::with_model(api_key.to_string(), model)?;

    let response = client
        .generate_content()
        .with_user_message("Please describe what you see in this video frame.")
        .with_inline_data(b64, "image/png")
        .execute()
        .await?;

    Ok(response.text())
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

/// Process a whole video at `video_path`, scheduling frame analysis on a bounded
/// async worker pool so LLM calls and encoding happen concurrently.
pub async fn process_video(video_path: impl Into<PathBuf>) -> Result<Vec<FrameRecord>> {
    video_rs::init().map_err(|_e| anyhow::anyhow!("video_rs init failed"))?;

    let file_path = video_path.into();
    let source = Location::File(file_path);
    let mut decoder = Decoder::new(&source)?;

    fs::create_dir_all("data")
        .await
        .context("failed to ensure data directory exists")?;

    let api_key = env::var("GOOGLE_API_KEY")?;
    let model_name = env::var("GEMINI_MODEL").ok();
    let model = resolve_model(model_name.as_deref());
    let max_concurrency = load_llm_max_concurrency();
    let job_ctx = FrameJobContext::new(api_key, model, max_concurrency);
    let mut tasks: JoinSet<Result<FrameRecord>> = JoinSet::new();

    let (width, height) = decoder.size_out();

    // 1) First frame -> send to LLM asynchronously
    let mut iter = decoder.decode_iter();
    let mut ref_img: Option<ImageBuffer<Rgb<u8>, Vec<u8>>> = None;
    let first_frame_id = 0_u64;

    info!("Decoding first frame and dispatching to LLM queue...");
    while let Some(res) = iter.next() {
        if let Ok((_ts, frame)) = res {
            let data = frame
                .as_slice()
                .ok_or_else(|| anyhow::anyhow!("Failed to get frame data"))?;
            let img: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_raw(width, height, data.to_vec())
                .ok_or_else(|| anyhow::anyhow!("Failed to create image buffer"))?;
            job_ctx.queue(&mut tasks, first_frame_id, 0.0, img.clone());
            ref_img = Some(img);
            info!("First frame enqueued; starting sampling at 0.5s");
            break;
        }
    }

    let mut ref_img = match ref_img {
        Some(img) => img,
        None => return Err(anyhow::anyhow!("No frame found")),
    };

    // 2) Collect samples every ~0.5s for sliding-window processing
    let mut next_sample = 0.5_f64; // seconds
    let mut samples: Vec<Sample> = Vec::new();
    let mut next_id = 1_u64; // aggregate frame id for samples; first was 0

    let mut frames_seen: u64 = 0;
    let mut last_ts: f64 = 0.0;
    for r in iter {
        match r {
            Ok((timestamp, frame)) => {
                let ts = timestamp.as_secs_f64();
                frames_seen += 1;
                last_ts = ts;
                if ts == 0.0 && !timestamp.has_value() {
                    warn!("Frame {} has no PTS/DTS; as_secs_f64()=0.0", frames_seen);
                }
                if frames_seen % 30 == 0 {
                    info!("Decoded {} frames so far; last ts={:.3}", frames_seen, ts);
                }
                if ts + 1e-6 >= next_sample {
                    let data = frame
                        .as_slice()
                        .ok_or_else(|| anyhow::anyhow!("Failed to get frame data"))?;
                    let img: ImageBuffer<Rgb<u8>, _> =
                        ImageBuffer::from_raw(width, height, data.to_vec())
                            .ok_or_else(|| anyhow::anyhow!("Failed to create image buffer"))?;

                    while ts + 1e-6 >= next_sample {
                        samples.push((next_id, next_sample, img.clone()));
                        info!(
                            "Sampled id={} at ~{:.3}s (samples total: {})",
                            next_id,
                            next_sample,
                            samples.len()
                        );
                        next_id += 1;
                        next_sample += 0.5;
                    }
                }
            }
            Err(e) => {
                info!(
                    "Decode iterator yielded error (likely EOF): {}. Exiting decode loop.",
                    e
                );
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
        info!(
            "Not enough samples for comparisons ({}). Gathering queued results.",
            samples.len()
        );
    }
    let total_pairs = samples.len().saturating_sub(1);
    info!(
        "Starting sliding-window comparisons: total_pairs={} starting_left={}",
        total_pairs, left
    );
    let mut processed_pairs = 0usize;
    let mut frames_enqueued = 1usize; // first frame already queued
    while left + 1 < samples.len() {
        let pair = [
            (samples[left].0, samples[left].1, samples[left].2.clone()),
            (
                samples[left + 1].0,
                samples[left + 1].1,
                samples[left + 1].2.clone(),
            ),
        ];
        info!(
            "Comparing pair: left=id{}@{:.3}s right=id{}@{:.3}s",
            samples[left].0,
            samples[left].1,
            samples[left + 1].0,
            samples[left + 1].1
        );
        let selection = process_frame(&ref_img_cur, pair).await?;
        info!(
            "Chosen frame id={} at {:.3}s; queuing for LLM",
            selection.frame_id, selection.timestamp
        );
        job_ctx.queue(
            &mut tasks,
            selection.frame_id,
            selection.timestamp,
            selection.image.clone(),
        );
        frames_enqueued += 1;

        if selection.chosen_left {
            left += 1;
        } else {
            left += 2;
        }

        ref_img_cur = selection.image;
        processed_pairs += 1;
    }

    info!(
        "Sliding-window comparisons complete: processed_pairs={}",
        processed_pairs
    );
    info!(
        "Total frames enqueued for LLM processing: {}",
        frames_enqueued
    );

    let mut records: Vec<FrameRecord> = Vec::new();
    while let Some(result) = tasks.join_next().await {
        let record = result.context("LLM task join error")??;
        records.push(record);
    }

    records.sort_by(|a, b| {
        a.timestamp
            .partial_cmp(&b.timestamp)
            .unwrap_or(Ordering::Equal)
    });

    info!("Processing complete: {} records", records.len());
    println!("{}", serde_json::to_string_pretty(&records)?);
    Ok(records)
}

/// Compare two frames to the current reference frame via cosine similarity.
/// Returns the chosen frame (the one that differs the most) along with metadata.
pub async fn process_frame(
    ref_img: &ImageBuffer<Rgb<u8>, Vec<u8>>,
    pair: [Sample; 2],
) -> Result<FrameSelection> {
    let [left, right] = pair;

    let left_id = left.0;
    let left_ts = left.1;
    let left_img = left.2;

    let right_id = right.0;
    let right_ts = right.1;
    let right_img = right.2;

    let ref_clone = ref_img.clone();
    let left_for_cos = left_img.clone();
    let right_for_cos = right_img.clone();

    let (chosen_left, cos_left, cos_right) = tokio::task::spawn_blocking(move || {
        let cos_left = cosine_similarity(&ref_clone, &left_for_cos);
        let cos_right = cosine_similarity(&ref_clone, &right_for_cos);
        (cos_left <= cos_right, cos_left, cos_right)
    })
    .await
    .context("cosine similarity task panicked")?;

    info!(
        "Cosines vs ref: id{} -> {:.6}, id{} -> {:.6}",
        left_id, cos_left, right_id, cos_right
    );

    if chosen_left {
        Ok(FrameSelection {
            frame_id: left_id,
            timestamp: left_ts,
            image: left_img,
            chosen_left: true,
        })
    } else {
        Ok(FrameSelection {
            frame_id: right_id,
            timestamp: right_ts,
            image: right_img,
            chosen_left: false,
        })
    }
}

// ==================
// Small helper funcs
// ==================

fn cosine_similarity(a: &ImageBuffer<Rgb<u8>, Vec<u8>>, b: &ImageBuffer<Rgb<u8>, Vec<u8>>) -> f64 {
    let ar = a.as_raw();
    let br = b.as_raw();
    if ar.len() != br.len() || ar.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut na = 0.0_f64;
    let mut nb = 0.0_f64;
    for (&x, &y) in ar.iter().zip(br.iter()) {
        let xf = x as f64;
        let yf = y as f64;
        dot += xf * yf;
        na += xf * xf;
        nb += yf * yf;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}
