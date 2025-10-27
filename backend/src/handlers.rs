use axum::{extract::Json, response::IntoResponse};
use axum::extract::Multipart;
use serde_json::json;
use serde::Deserialize;
use crate::services;
use std::path::PathBuf;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tracing::info;

/// Health check handler - returns server status
pub async fn health_check() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "message": "Server is running"
    }))
}


pub async fn test() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "message": "Test successful"
    }))
}


#[derive(Deserialize)]
pub struct ProcessVideoRequest {
    pub video_path: String,
}

pub async fn process_video(Json(req): Json<ProcessVideoRequest>) -> impl IntoResponse {
    match services::process_video(req.video_path).await {
        Ok(records) => {
            // Add a concise summary of the records
            let summary = match services::summarize_records(&records).await {
                Ok(s) => s,
                Err(e) => format!("Failed to summarize: {}", e),
            };
            Json(json!({
                "status": "ok",
                "records": records,
                "summary": summary
            }))
        },
        Err(e) => Json(json!({
            "status": "error",
            "message": format!("Failed to process video: {}", e)
        }))
    }
}

/// Upload handler - receives video file and saves it to data/ folder
pub async fn upload_video(mut multipart: Multipart) -> impl IntoResponse {
    info!("Received upload request");
    
    // Create data directory if it doesn't exist
    let data_dir = PathBuf::from("data");
    if let Err(e) = fs::create_dir_all(&data_dir).await {
        return Json(json!({
            "status": "error",
            "message": format!("Failed to create data directory: {}", e)
        }));
    }

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(e) => {
                return Json(json!({
                    "status": "error",
                    "message": format!("Failed to parse multipart data: {}", e)
                }));
            }
        };

        let name = field.name().unwrap_or("").to_string();
        let filename = field.file_name().unwrap_or("video.mp4").to_string();
        
        info!("Processing field: {}, filename: {}", name, filename);
        
        // Generate unique filename with timestamp
        let unique_filename = format!("{}_{}", 
            chrono::Utc::now().timestamp_millis(), 
            filename
        );
        let file_path = data_dir.join(&unique_filename);
        
        // Read the file data
        let data = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(e) => {
                return Json(json!({
                    "status": "error",
                    "message": format!("Failed to read file data: {}", e)
                }));
            }
        };
        
        // Write to file
        match fs::File::create(&file_path).await {
            Ok(mut file) => {
                if let Err(e) = file.write_all(&data).await {
                    return Json(json!({
                        "status": "error",
                        "message": format!("Failed to write file: {}", e)
                    }));
                }
                info!("Saved video to: {:?}", file_path);
                
                // Return the path for processing
                return Json(json!({
                    "status": "ok",
                    "message": "File uploaded successfully",
                    "video_path": file_path.to_string_lossy().to_string()
                }));
            },
            Err(e) => {
                return Json(json!({
                    "status": "error",
                    "message": format!("Failed to create file: {}", e)
                }));
            }
        }
    }
    
    Json(json!({
        "status": "error",
        "message": "No file provided"
    }))
}
