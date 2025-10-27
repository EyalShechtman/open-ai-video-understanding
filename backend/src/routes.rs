use axum::{routing::{get, post}, Router, extract::{Json, DefaultBodyLimit}};
use crate::handlers;
use tower_http::cors::{CorsLayer, Any};
use tower_http::services::ServeDir;

/// Creates and returns the main router with all routes
pub fn create_router() -> Router {
    // Configure CORS to allow frontend calls
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/health", get(handlers::health_check))
        .route("/test", get(handlers::test))
        .route("/upload", post(handlers::upload_video))
        .route(
            "/process-video",
            post(|Json(req): Json<handlers::ProcessVideoRequest>| async move {
                handlers::process_video(Json(req)).await
            }),
        )
        // Serve frame images from the local data directory for thumbnails
        .nest_service("/data", ServeDir::new("data"))
        .layer(DefaultBodyLimit::max(500 * 1024 * 1024)) // 500 MB limit
        .layer(cors)
}
