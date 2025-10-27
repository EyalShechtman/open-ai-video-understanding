use axum::{extract::Json, response::IntoResponse};
use serde_json::json;
use serde::Deserialize;
use crate::services;

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
