use axum::{routing::{get, post}, Router, extract::Json};
use crate::handlers;

/// Creates and returns the main router with all routes
pub fn create_router() -> Router {
    Router::new()
        .route("/health", get(handlers::health_check))
        .route("/test", get(handlers::test))
        .route(
            "/process-video",
            post(|Json(req): Json<handlers::ProcessVideoRequest>| async move {
                handlers::process_video(Json(req)).await
            }),
        )
}
