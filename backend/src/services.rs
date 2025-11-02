use anyhow::{Context, Result};
use base64::{engine::general_purpose, Engine as _};
use gemini_rust::{Gemini, Model};
use image::codecs::jpeg::JpegEncoder;
use image::ImageEncoder;
use image::{ImageBuffer, Rgb};
use ffmpeg_next as ffmpeg;
use ffmpeg::format::{input as ff_input, Pixel as FfmpegPixel};
use ffmpeg::media::Type as FfmpegMediaType;
use ffmpeg::software::scaling::{context::Context as FfmpegScaler, flag::Flags as FfmpegScaleFlags};
use ffmpeg::util::frame::video::Video as FfmpegVideo;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{info, warn};
// video_rs decoder removed for Y-plane path

// ==========================
// Public API (3 main funcs)
// ==========================

// Record returned by `process_video` for each selected/sent frame.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FrameRecord {
    pub frame_id: u64,
    pub timestamp: f64,
    pub description: String,
    pub path: String, // using file path; can switch to base64 if you prefer
    #[serde(skip)]
    pub jpeg_bytes: Option<Vec<u8>>, // Hold in memory during processing, skip serialization
}

// Compact per-sample feature used for cosine similarity (64x64 grayscale -> 4096D)
#[derive(Clone)]
struct SampleFeature {
    vec: Vec<f32>, // length 4096
    l2: f32,
}

/// Runtime context for queuing frame-description jobs with bounded concurrency.
#[derive(Clone)]
struct FrameJobContext {
    api_key: Arc<String>,
    model: Model,
    semaphore: Arc<Semaphore>,
    video_id: Arc<String>, // Unique identifier for this video
}

impl FrameJobContext {
    fn new(api_key: String, model: Model, max_concurrency: usize, video_id: String) -> Self {
        Self {
            api_key: Arc::new(api_key),
            model,
            semaphore: Arc::new(Semaphore::new(max_concurrency.max(1))),
            video_id: Arc::new(video_id),
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

            let jpeg_bytes = tokio::task::spawn_blocking(move || encode_jpeg(image))
                .await
                .context("JPEG encode task panicked")??;

            // Use video_id to create unique frame paths per video
            let path = format!("data/{}_frame_{:03}.jpg", ctx.video_id, frame_id);
            
            // Skip disk write during processing - keep in memory
            // Disk writes will happen after all LLM calls complete
            let description =
                describe_jpeg_bytes(ctx.api_key.as_ref(), ctx.model, jpeg_bytes.clone()).await?;

            Ok(FrameRecord {
                frame_id,
                timestamp,
                description,
                path,
                jpeg_bytes: Some(jpeg_bytes), // Keep bytes in memory
            })
        });
    }
}

// (removed) FrameSelection; streaming selection uses direct enqueuing.

fn load_llm_max_concurrency() -> usize {
    const DEFAULT: usize = 100;
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

fn encode_jpeg(image: ImageBuffer<Rgb<u8>, Vec<u8>>) -> Result<Vec<u8>> {
    let width = image.width();
    let height = image.height();
    let raw = image.into_raw();
    let mut buf = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut buf, 85);
    encoder.write_image(&raw, width, height, image::ColorType::Rgb8.into())?;
    Ok(buf)
}

async fn describe_jpeg_bytes(api_key: &str, model: Model, jpeg_bytes: Vec<u8>) -> Result<String> {
    let b64 = tokio::task::spawn_blocking(move || general_purpose::STANDARD.encode(jpeg_bytes))
        .await
        .context("base64 encode task panicked")?;

    let client = Gemini::with_model(api_key.to_string(), model)?;

    let response = client
        .generate_content()
        .with_user_message("Please describe what you see in this video frame with extremely detailed description try to understand the context of the frames. Make speculative guesses about what might be happening based on the frame!")
        .with_inline_data(b64, "image/jpeg")
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
    transcript.push_str("Summarize the video in detail description, should be 3-5 sentences.\n\nFrames:\n. Based on all the frmaes, try to keep a story line and explain what happened in the video. Describe the story not the specific details.");
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
    ffmpeg::init().map_err(|e| anyhow::anyhow!("ffmpeg init failed: {e}"))?;

    let file_path = video_path.into();
    fs::create_dir_all("data")
        .await
        .context("failed to ensure data directory exists")?;

    // Extract video ID from the filename (e.g., "1761542252139_crashDemo.mp4" -> "1761542252139_crashDemo")
    let video_id = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    
    info!("Processing video with ID: {}", video_id);

    let api_key = env::var("GOOGLE_API_KEY")?;
    let model_name = env::var("GEMINI_MODEL").ok();
    let model = resolve_model(model_name.as_deref());
    let max_concurrency = load_llm_max_concurrency();
    let job_ctx = FrameJobContext::new(api_key, model, max_concurrency, video_id);
    let mut tasks: JoinSet<Result<FrameRecord>> = JoinSet::new();

    // Run decode + selection in an isolated scope so ffmpeg types are dropped before awaits
    let frames_enqueued = {
        // Open input and prepare decoder
        let mut ictx = ff_input(&file_path)
            .with_context(|| format!("failed to open video file: {:?}", file_path))?;
        let input_stream = ictx
            .streams()
            .best(FfmpegMediaType::Video)
            .ok_or_else(|| anyhow::anyhow!("No video stream found"))?;
        let stream_index = input_stream.index();
        let time_base = input_stream.time_base();
        let context_decoder = ffmpeg::codec::context::Context::from_parameters(input_stream.parameters())?;
        let mut decoder = context_decoder.decoder().video()?;

        // Helper scaler (lazy init) for winners -> RGB24 -> JPEG
        let mut scaler: Option<FfmpegScaler> = None;
        fn ensure_scaler_impl(
            scaler: &mut Option<FfmpegScaler>,
            src_format: FfmpegPixel,
            w: u32,
            h: u32,
        ) -> Result<()> {
            let need_new = match scaler {
                Some(s) => {
                    let inp = s.input();
                    let out = s.output();
                    inp.format != src_format
                        || inp.width != w
                        || inp.height != h
                        || out.format != FfmpegPixel::RGB24
                        || out.width != w
                        || out.height != h
                }
                None => true,
            };
            if need_new {
                *scaler = Some(
                    FfmpegScaler::get(
                        src_format,
                        w,
                        h,
                        FfmpegPixel::RGB24,
                        w,
                        h,
                        FfmpegScaleFlags::BILINEAR,
                    )
                    .map_err(anyhow::Error::from)?,
                );
            }
            Ok(())
        }

        // Utility to convert a frame to RGB ImageBuffer for JPEG/LLM
        let mut to_rgb_image = |frame: &FfmpegVideo| -> Result<ImageBuffer<Rgb<u8>, Vec<u8>>> {
            ensure_scaler_impl(&mut scaler, frame.format(), frame.width(), frame.height())?;
            let mut rgb = FfmpegVideo::empty();
            scaler.as_mut().unwrap().run(frame, &mut rgb)?;
            let w = rgb.width();
            let h = rgb.height();
            let stride = rgb.stride(0);
            let src = rgb.data(0);
            let row_len = (w as usize) * 3;
            let mut out = vec![0u8; row_len * (h as usize)];
            for y in 0..(h as usize) {
                let src_off = y * stride;
                let dst_off = y * row_len;
                out[dst_off..dst_off + row_len].copy_from_slice(&src[src_off..src_off + row_len]);
            }
            ImageBuffer::from_raw(w, h, out)
                .ok_or_else(|| anyhow::anyhow!("failed to build RGB image"))
        };

        // Y-plane feature reference
        let mut frames_enqueued = 0usize;
        let first_frame_id = 0_u64;
        info!("Decoding first frame and dispatching to LLM queue...");
        let mut first_done = false;

        // Streaming pairwise selection state
        let mut next_sample = 0.25_f64;
        let mut next_id = 1_u64;
        let mut frames_seen: u64 = 0;
        let mut last_ts: f64 = 0.0;
        let mut pending: Option<(u64, f64, FfmpegVideo, SampleFeature)> = None; // (id, ts, frame, feat)
        let mut ref_vec: Vec<f32> = Vec::new();
        let mut ref_l2: f32 = 0.0;

        let mut receive_and_process = |decoder: &mut ffmpeg::decoder::Video,
                                       packet_ts: Option<i64>|
         -> Result<()> {
            let mut decoded = FfmpegVideo::empty();
            while decoder.receive_frame(&mut decoded).is_ok() {
                // Timestamp in seconds
                let ts_units = decoded.timestamp().or(packet_ts).unwrap_or(0);
                let ts = (ts_units as f64)
                    * (time_base.numerator() as f64 / time_base.denominator() as f64);
                frames_seen += 1;
                last_ts = ts;

                if !first_done {
                    // Initialize reference from Y plane
                    let (v, l2) = compute_feature_from_y(&decoded)?;
                    ref_vec = v;
                    ref_l2 = l2;

                    // Queue first frame for LLM
                    let img = to_rgb_image(&decoded)?;
                    job_ctx.queue(&mut tasks, first_frame_id, 0.0, img.clone());
                    frames_enqueued += 1;
                    first_done = true;
                    continue;
                }

                // Sampling and streaming pairwise selection
                if ts + 1e-6 >= next_sample {
                    // Compute features once for this decoded frame and reuse
                    let (img_vec, img_l2) = compute_feature_from_y(&decoded)?;
                    let src_format = decoded.format();
                    let w = decoded.width();
                    let h = decoded.height();

                    while ts + 1e-6 >= next_sample {
                        // Capture frame for potential queue; clone only when needed
                        let mut owned = FfmpegVideo::empty();
                        unsafe {
                            // Allocate and copy decoded into owned clone
                            owned.alloc(src_format, w, h);
                        }
                        // Copy planes
                        for plane in 0..decoded.planes() {
                            let src = decoded.data(plane);
                            let stride = decoded.stride(plane);
                            let plane_h = decoded.plane_height(plane) as usize;
                            let row_len = stride;
                            let dst = owned.data_mut(plane);
                            for y in 0..plane_h {
                                let s = &src[y * stride..y * stride + row_len];
                                let d = &mut dst[y * stride..y * stride + row_len];
                                d.copy_from_slice(s);
                            }
                        }

                        let feat = SampleFeature { vec: img_vec.clone(), l2: img_l2 };
                        match pending.take() {
                            None => {
                                pending = Some((next_id, next_sample, owned, feat));
                            }
                            Some((left_id, left_ts, left_frame, left_feat)) => {
                                let cos_left = cosine_similarity_feats(
                                    &ref_vec, ref_l2, &left_feat.vec, left_feat.l2,
                                );
                                let cos_right = cosine_similarity_feats(
                                    &ref_vec, ref_l2, &feat.vec, feat.l2,
                                );
                                let choose_left = cos_left <= cos_right;
                                info!(
                                    "Cosines vs ref: id{} -> {:.6}, id{} -> {:.6}",
                                    left_id, cos_left, next_id, cos_right
                                );

                                if choose_left {
                                    // Convert left_frame to RGB and queue
                                    let img = to_rgb_image(&left_frame)?;
                                    job_ctx.queue(&mut tasks, left_id, left_ts, img);
                                    frames_enqueued += 1;
                                    // Update reference
                                    ref_vec = left_feat.vec;
                                    ref_l2 = left_feat.l2;
                                    // Shift window: current becomes new pending
                                    pending = Some((next_id, next_sample, owned, feat));
                                } else {
                                    // Convert current frame to RGB and queue
                                    let img = to_rgb_image(&owned)?;
                                    job_ctx.queue(&mut tasks, next_id, next_sample, img);
                                    frames_enqueued += 1;
                                    ref_vec = feat.vec;
                                    ref_l2 = feat.l2;
                                    // Step by 2
                                    pending = None;
                                }
                            }
                        }

                        info!("Sampled id={} at ~{:.3}s", next_id, next_sample);
                        next_id += 1;
                        next_sample += 0.25;
                    }
                }
            }
            Ok(())
        };

        for (stream, packet) in ictx.packets() {
            if stream.index() != stream_index {
                continue;
            }
            decoder.send_packet(&packet)?;
            receive_and_process(&mut decoder, packet.dts())?;
        }
        decoder.send_eof()?;
        receive_and_process(&mut decoder, None)?;

        info!("Decode loop finished");
        info!("Total frames enqueued for LLM processing: {}", frames_enqueued);
        frames_enqueued
    };

    info!("Total frames enqueued for LLM processing: {}", frames_enqueued);

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
    
    // Now write all frames to disk in parallel
    info!("Writing {} frames to disk...", records.len());
    let mut write_tasks = JoinSet::new();
    for record in &records {
        if let Some(bytes) = &record.jpeg_bytes {
            let path = record.path.clone();
            let bytes = bytes.clone();
            write_tasks.spawn(async move {
                fs::write(&path, &bytes)
                    .await
                    .with_context(|| format!("failed to write frame to {}", path))
            });
        }
    }
    
    // Wait for all writes to complete
    while let Some(result) = write_tasks.join_next().await {
        result.context("disk write task join error")??;
    }
    info!("All frames written to disk");
    
    println!("{}", serde_json::to_string_pretty(&records)?);
    Ok(records)
}

// ==================
// Small helper funcs
// ==================

// Compute 64x64 feature from Y plane only. Supports common 8-bit YUV formats (YUV420p/NV12).
fn compute_feature_from_y(frame: &FfmpegVideo) -> Result<(Vec<f32>, f32)> {
    // Get Y plane geometry
    let w = frame.width() as usize;
    let h = frame.height() as usize;
    let stride = frame.stride(0);
    let y_plane = frame.data(0);

    // Bilinear downscale to 64x64
    const OUT: usize = 64;
    let scale_x = (w as f32) / (OUT as f32);
    let scale_y = (h as f32) / (OUT as f32);

    let mut feat = Vec::with_capacity(OUT * OUT);
    let mut sumsq: f32 = 0.0;
    for oy in 0..OUT {
        let src_y = (oy as f32 + 0.5) * scale_y - 0.5;
        let y0 = src_y.floor().max(0.0) as isize;
        let y1 = (y0 + 1).min((h as isize) - 1);
        let wy1 = (src_y - y0 as f32).clamp(0.0, 1.0);
        let wy0 = 1.0 - wy1;
        for ox in 0..OUT {
            let src_x = (ox as f32 + 0.5) * scale_x - 0.5;
            let x0 = src_x.floor().max(0.0) as isize;
            let x1 = (x0 + 1).min((w as isize) - 1);
            let wx1 = (src_x - x0 as f32).clamp(0.0, 1.0);
            let wx0 = 1.0 - wx1;

            let idx00 = (y0 as usize) * stride + (x0 as usize);
            let idx01 = (y0 as usize) * stride + (x1 as usize);
            let idx10 = (y1 as usize) * stride + (x0 as usize);
            let idx11 = (y1 as usize) * stride + (x1 as usize);

            let y00 = y_plane[idx00] as f32;
            let y01 = y_plane[idx01] as f32;
            let y10 = y_plane[idx10] as f32;
            let y11 = y_plane[idx11] as f32;

            let y0i = y00 * wx0 + y01 * wx1;
            let y1i = y10 * wx0 + y11 * wx1;
            let yv = (y0i * wy0 + y1i * wy1) / 255.0;
            feat.push(yv);
            sumsq += yv * yv;
        }
    }
    let l2 = sumsq.sqrt();
    Ok((feat, l2))
}

// Cosine similarity over precomputed feature vectors and norms
fn cosine_similarity_feats(ref_vec: &[f32], ref_l2: f32, v: &[f32], l2: f32) -> f32 {
    if ref_l2 == 0.0 || l2 == 0.0 || ref_vec.len() != v.len() || ref_vec.is_empty() {
        return 0.0;
    }
    let mut dot: f32 = 0.0;
    for (a, b) in ref_vec.iter().zip(v.iter()) {
        dot += a * b;
    }
    dot / (ref_l2 * l2)
}
